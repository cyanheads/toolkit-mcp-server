/**
 * @fileoverview GeoService — the one external dependency. DNS-resolves a hostname
 * to an IP, calls the ip-api-compatible geolocation endpoint with retry/backoff,
 * bounds and strips the provider's strings, normalizes the sparse payload, and
 * caches by resolved IP under a hard entry cap. The private-range guard runs
 * AFTER resolution so a hostname cannot smuggle a request to an internal IP.
 * @module services/geo/geo-service
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Context } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import {
  McpError,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  fetchWithTimeout,
  logger,
  RateLimiter,
  withExtra,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { isPrivateOrReservedIp } from '@/services/network/target.js';
import type { GeoBatchFailure, GeoBatchResult, GeoResult } from './types.js';

/** Raw ip-api response — every geo field is optional; only status/query are reliable. */
type IpApiResponse = {
  status: 'success' | 'fail';
  message?: string;
  country?: string;
  countryCode?: string;
  regionName?: string;
  city?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  org?: string;
  isp?: string;
  as?: string;
  proxy?: boolean;
  hosting?: boolean;
  mobile?: boolean;
  query?: string;
};

const IP_API_FIELDS =
  'status,message,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,proxy,hosting,mobile,query';

/**
 * The only implemented provider protocol. Reported as `source` and named in the
 * sanitized failure message, so provenance never reflects an environment value:
 * TOOLKIT_GEO_BASE_URL can point at an ip-api-compatible endpoint, but the
 * request and response shapes are always ip-api's.
 */
const GEO_PROVIDER = 'ip-api';

/**
 * Hard cap on resident cache entries. The cache is keyed by resolved IP, so a
 * long-lived process geolocating varied IPs would otherwise grow without bound:
 * an entry for an IP looked up once is never read again, and TTL alone never
 * reclaims a slot nothing touches.
 */
export const GEO_CACHE_MAX_ENTRIES = 1000;

/** Ceiling on any provider-supplied string. No legitimate city or org exceeds it. */
export const GEO_FIELD_MAX_LENGTH = 256;

/**
 * Unicode control characters (C0, DEL, C1) — newlines included. Provider text
 * carrying these can forge structure in the Markdown surface a model reads.
 */
const CONTROL_CHARS = /\p{Cc}+/gu;

type CacheEntry = { result: GeoResult; expiresAt: number };

/** Fixed key for the process-wide outbound geolocation throttle. */
const RATE_LIMIT_KEY = 'geo-lookup';

/**
 * Bound and strip one provider-supplied string. `org`, `isp`, and `as` come from
 * registry records the address holder controls, and the keyless ip-api tier is
 * plaintext HTTP, so these values are third-party text that lands verbatim in an
 * LLM's context. A control run collapses to a single space rather than vanishing,
 * so stripping cannot weld two words together. Returns `undefined` for an empty
 * result, preserving the no-fabrication rule for absent upstream fields.
 */
function boundedField(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(CONTROL_CHARS, ' ').trim().slice(0, GEO_FIELD_MAX_LENGTH);
  return cleaned || undefined;
}

/** Compare equivalent IPv6 spellings as well as literal IPv4 provider queries. */
function sameIp(query: string, resolvedIp: string): boolean {
  const family = isIP(query);
  if (family === 0 || query.includes('%')) return false;
  const canonical = (ip: string) => (isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip);
  return canonical(query) === canonical(resolvedIp);
}

export class GeoService {
  /**
   * In-memory TTL cache keyed by resolved IP. Geolocation is stable, so repeats
   * are cheap. Writes go through `cacheSet`, which holds the entry count at
   * GEO_CACHE_MAX_ENTRIES; the Map is insertion-ordered, so the oldest key is
   * the eviction victim.
   */
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Per-process throttle on outbound provider calls, bounded by
   * TOOLKIT_GEO_RATE_LIMIT_PER_MIN so the keyless free tier isn't blown past
   * accidentally. Single fixed key, so the per-key cleanup timer is disabled.
   */
  private readonly rateLimiter: RateLimiter;
  private readonly batchRateLimiter: RateLimiter;
  private readonly cooldownUntil = { single: 0, batch: 0 };

  constructor() {
    this.rateLimiter = this.makeLimiter(getServerConfig().geoRateLimitPerMin);
    this.batchRateLimiter = this.makeLimiter(getServerConfig().geoBatchRateLimitPerMin);
  }

  private makeLimiter(maxRequests: number): RateLimiter {
    const limiter = new RateLimiter(config, logger);
    limiter.configure({ maxRequests, windowMs: 60_000, cleanupInterval: 0 });
    return limiter;
  }

  private quotaError(waitTimeSeconds: number): McpError {
    return rateLimited(`Geolocation quota exhausted. Retry in ${waitTimeSeconds} seconds.`, {
      reason: 'rate_limited',
      waitTimeSeconds,
      retryable: true,
      recovery: {
        hint: `Wait ${waitTimeSeconds} seconds before retrying, or reuse a cached geolocation result.`,
      },
    });
  }

  private checkQuota(endpoint: 'single' | 'batch'): void {
    this.checkCooldown(endpoint);
    try {
      (endpoint === 'single' ? this.rateLimiter : this.batchRateLimiter).check(RATE_LIMIT_KEY);
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      throw this.quotaError(Number(error.data?.waitTimeSeconds));
    }
  }

  private checkCooldown(endpoint: 'single' | 'batch'): void {
    const wait = Math.ceil((this.cooldownUntil[endpoint] - Date.now()) / 1000);
    if (wait > 0) throw this.quotaError(wait);
  }

  private setCooldown(endpoint: 'single' | 'batch', ttl: string | undefined | null): number {
    const seconds = ttl && /^\d+$/.test(ttl) ? Number(ttl) : Number.NaN;
    const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60;
    this.cooldownUntil[endpoint] = Math.max(this.cooldownUntil[endpoint], Date.now() + wait * 1000);
    return wait;
  }

  private isProvider429(error: unknown): error is McpError {
    return error instanceof McpError && error.data?.status === 429;
  }

  private async request<T>(
    endpoint: 'single' | 'batch',
    url: URL,
    ctx: Context,
    body?: string,
  ): Promise<T> {
    ctx.signal.throwIfAborted();
    this.checkQuota(endpoint);
    try {
      return await withRetry(
        async () => {
          this.checkCooldown(endpoint);
          const response = await fetchWithTimeout(url.toString(), 8000, ctx, {
            signal: ctx.signal,
            errorHeaders: ['X-Ttl', 'X-Rl'],
            ...(body === undefined
              ? {}
              : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
          });
          if (response.headers?.get('X-Rl') === '0')
            this.setCooldown(endpoint, response.headers.get('X-Ttl'));
          return (await response.json()) as T;
        },
        {
          operation: endpoint === 'single' ? 'GeoService.lookup' : 'GeoService.lookupBatch',
          context: ctx,
          baseDelayMs: 1500,
          signal: ctx.signal,
          isTransient: (error) =>
            !this.isProvider429(error) &&
            !(error instanceof McpError && error.data?.reason === 'rate_limited') &&
            defaultIsTransient(error),
        },
      );
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      if (err instanceof McpError && err.data?.reason === 'rate_limited') throw err;
      if (this.isProvider429(err)) {
        const headers = err.data?.headers as Record<string, string> | undefined;
        throw this.quotaError(this.setCooldown(endpoint, headers?.['x-ttl']));
      }
      logger.error(
        'Geo provider request failed',
        err instanceof Error ? err : new Error(String(err)),
        withExtra(ctx, { endpoint }),
      );
      throw serviceUnavailable(
        `Geolocation provider "${GEO_PROVIDER}" is unavailable. Try again shortly.`,
        undefined,
        { cause: err },
      );
    }
  }

  /** Resolve a hostname to its first A/AAAA address; pass IPs through unchanged. */
  private async resolveTarget(target: string, ctx: Context): Promise<string> {
    ctx.signal.throwIfAborted();
    if (isIP(target) !== 0) return target;
    try {
      const { address } = await new Promise<{ address: string }>((resolve, reject) => {
        const abort = () => reject(ctx.signal.reason);
        ctx.signal.addEventListener('abort', abort, { once: true });
        void lookup(target)
          .then(resolve, reject)
          .finally(() => ctx.signal.removeEventListener('abort', abort));
      });
      return address;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      throw validationError(`Hostname "${target}" did not resolve.`, {
        reason: 'unresolvable_host',
      });
    }
  }

  /**
   * Geolocate an IP or hostname. Throws `validationError` (reason
   * `private_target`) for private/reserved or provider-unlocatable IPs, and a
   * sanitized `serviceUnavailable` when the provider request fails — the raw
   * upstream error (URL, HTTP status, response body, requestId) is logged
   * server-side but never surfaced to the client.
   */
  async lookup(target: string, ctx: Context): Promise<GeoResult> {
    const cfg = getServerConfig();
    const resolvedIp = await this.resolveTarget(target, ctx);
    ctx.signal.throwIfAborted();

    if (isPrivateOrReservedIp(resolvedIp)) {
      throw validationError(
        `${target} resolves to private/reserved address ${resolvedIp}, which has no public geolocation.`,
        { reason: 'private_target' },
      );
    }

    const cached = this.cache.get(resolvedIp);
    if (cached && cached.expiresAt > Date.now()) {
      ctx.log.debug('Geo cache hit', { resolvedIp });
      return { ...cached.result, target };
    }

    const url = new URL(`/json/${encodeURIComponent(resolvedIp)}`, cfg.geoBaseUrl);
    url.searchParams.set('fields', IP_API_FIELDS);
    if (cfg.geoApiKey) url.searchParams.set('key', cfg.geoApiKey);

    const raw = await this.request<IpApiResponse>('single', url, ctx);
    return this.accept(raw, target, resolvedIp, ctx);
  }

  private accept(raw: IpApiResponse, target: string, resolvedIp: string, ctx: Context): GeoResult {
    if (raw.status === 'fail') {
      logger.debug(
        'Geo provider could not locate address',
        withExtra(ctx, { resolvedIp, providerMessage: raw.message }),
      );
      // Provider classified the IP itself as unlocatable (reserved/bogon/unrouted).
      // This will never succeed on retry, so surface it as a (non-retryable)
      // validation error. The target passed the private-range guard, so it is a
      // public-format address — the recovery hint must NOT imply the caller
      // failed to pass a public IP (it reads oddly for e.g. TEST-NET ranges).
      throw validationError(`Geolocation provider could not locate ${resolvedIp}.`, {
        reason: 'private_target',
        retryable: false,
        recovery: {
          hint: 'This address has no public geolocation (it is reserved, unrouted, or bogon). Use a routable public IP.',
        },
      });
    }

    const result = this.normalize(raw, target, resolvedIp);
    this.cacheSet(resolvedIp, {
      result,
      expiresAt: Date.now() + getServerConfig().geoCacheTtlSeconds * 1000,
    });
    ctx.log.info('Geo lookup', { resolvedIp, country: result.countryCode ?? 'unknown' });
    return result;
  }

  /** Geolocate the first 100 input positions through one independent batch request. */
  async lookupBatch(targets: string[], ctx: Context): Promise<GeoBatchResult> {
    if (targets.length > 1000)
      throw validationError('At most 1000 geolocation targets may be supplied.');
    const results: (GeoResult | GeoBatchFailure)[] = [];
    const misses: { index: number; target: string; resolvedIp: string }[] = [];
    const failure = (target: string, error: unknown): GeoBatchFailure => {
      if (ctx.signal.aborted) throw error;
      if (!(error instanceof McpError)) throw error;
      const reason = (error.data?.reason ??
        'provider_unavailable') as GeoBatchFailure['error']['reason'];
      const recovery = error.data?.recovery as { hint: string } | undefined;
      return {
        target,
        error: {
          reason,
          message: error.message,
          ...(typeof error.data?.waitTimeSeconds === 'number'
            ? { waitTimeSeconds: error.data.waitTimeSeconds }
            : {}),
          recovery: recovery ?? {
            hint:
              reason === 'unresolvable_host'
                ? 'Verify the hostname, or pass an IP address directly.'
                : reason === 'private_target'
                  ? 'Use a routable public IP with public geolocation.'
                  : 'Try the geolocation lookup again shortly.',
          },
        },
      };
    };
    for (const target of targets.slice(0, 100)) {
      ctx.signal.throwIfAborted();
      const index = results.length;
      try {
        const resolvedIp = await this.resolveTarget(target, ctx);
        ctx.signal.throwIfAborted();
        if (isPrivateOrReservedIp(resolvedIp))
          throw validationError(
            `${target} resolves to private/reserved address ${resolvedIp}, which has no public geolocation.`,
            { reason: 'private_target' },
          );
        const cached = this.cache.get(resolvedIp);
        if (cached && cached.expiresAt > Date.now()) results.push({ ...cached.result, target });
        else {
          // Placeholder is replaced after the request; positions include duplicates.
          results.push({ target, resolvedIp, source: GEO_PROVIDER });
          misses.push({ index, target, resolvedIp });
        }
      } catch (error) {
        results.push(failure(target, error));
      }
    }
    if (misses.length) {
      const url = new URL('/batch', getServerConfig().geoBaseUrl);
      url.searchParams.set('fields', IP_API_FIELDS);
      const key = getServerConfig().geoApiKey;
      if (key) url.searchParams.set('key', key);
      try {
        const raw = await this.request<IpApiResponse[]>(
          'batch',
          url,
          ctx,
          JSON.stringify(misses.map(({ resolvedIp }) => ({ query: resolvedIp }))),
        );
        if (
          !Array.isArray(raw) ||
          raw.length !== misses.length ||
          raw.some(
            (row, index) =>
              !row ||
              !['success', 'fail'].includes(row.status) ||
              (row.query !== undefined &&
                (typeof row.query !== 'string' ||
                  !sameIp(row.query, (misses[index] as { resolvedIp: string }).resolvedIp))),
          )
        )
          throw serviceUnavailable(
            'Geolocation provider returned an invalid batch response. Try again shortly.',
          );
        for (const [position, entry] of misses.entries()) {
          ctx.signal.throwIfAborted();
          try {
            results[entry.index] = this.accept(
              raw[position] as IpApiResponse,
              entry.target,
              entry.resolvedIp,
              ctx,
            );
          } catch (error) {
            results[entry.index] = failure(entry.target, error);
          }
        }
      } catch (error) {
        for (const entry of misses) results[entry.index] = failure(entry.target, error);
      }
    }
    ctx.signal.throwIfAborted();
    return {
      results,
      failedCount: results.filter((row) => 'error' in row).length,
      unprocessedTargets: targets.slice(100),
    };
  }

  /**
   * Map the raw ip-api payload to GeoResult, omitting absent fields (never
   * fabricating). Every provider-supplied string passes through `boundedField`
   * first, so both the returned and the cached result carry bounded, stripped
   * values — including the `asn` fallback, which is derived from the already
   * bounded `as` string rather than the raw one.
   */
  private normalize(raw: IpApiResponse, target: string, resolvedIp: string): GeoResult {
    const result: GeoResult = { target, resolvedIp, source: GEO_PROVIDER };
    const country = boundedField(raw.country);
    if (country) result.country = country;
    const countryCode = boundedField(raw.countryCode);
    if (countryCode) result.countryCode = countryCode;
    const region = boundedField(raw.regionName);
    if (region) result.region = region;
    const city = boundedField(raw.city);
    if (city) result.city = city;
    if (typeof raw.lat === 'number') result.latitude = raw.lat;
    if (typeof raw.lon === 'number') result.longitude = raw.lon;
    const timezone = boundedField(raw.timezone);
    if (timezone) result.timezone = timezone;
    // ip-api's `as` is "AS15169 Google LLC" — split the ASN token from the org name.
    const asField = boundedField(raw.as);
    if (asField) {
      const match = asField.match(/^(AS\d+)\s*(.*)$/);
      result.asn = match?.[1] ?? asField;
      const orgFromAs = match?.[2]?.trim();
      if (orgFromAs) result.org = orgFromAs;
    }
    // Prefer the dedicated org field; fall back to isp; finally to the `as`-derived org.
    const org = boundedField(raw.org);
    const isp = boundedField(raw.isp);
    if (org) result.org = org;
    else if (isp && !result.org) result.org = isp;
    // Quality flags — absent when the provider does not report them, so the model
    // can tell "not a proxy" from "the provider did not say".
    if (typeof raw.proxy === 'boolean') result.proxy = raw.proxy;
    if (typeof raw.hosting === 'boolean') result.hosting = raw.hosting;
    if (typeof raw.mobile === 'boolean') result.mobile = raw.mobile;
    return result;
  }

  /**
   * Write one cache entry, holding the Map at GEO_CACHE_MAX_ENTRIES by dropping
   * the oldest entry when a new key would push it over. The leading delete is
   * what makes the entry order-relevant — it moves a refreshed key to the tail
   * and keeps the size check from evicting on a plain overwrite; on its own,
   * delete-then-set of the same key would be indistinguishable from a bare set.
   */
  private cacheSet(resolvedIp: string, entry: CacheEntry): void {
    this.cache.delete(resolvedIp);
    while (this.cache.size >= GEO_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(resolvedIp, entry);
  }
}

// --- Init/accessor pattern ---

let _service: GeoService | undefined;

/**
 * Initialize the GeoService singleton — call from createApp setup(). The service
 * uses parsed server settings for its process-local cache and quota limits;
 * it does not require persistent storage.
 */
export function initGeoService(): void {
  _service = new GeoService();
}

/** Access the GeoService singleton; throws if init was skipped. */
export function getGeoService(): GeoService {
  if (!_service) {
    throw new Error('GeoService not initialized — call initGeoService() in setup()');
  }
  return _service;
}
