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
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  fetchWithTimeout,
  logger,
  RateLimiter,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { isPrivateOrReservedIp } from '@/services/network/target.js';
import type { GeoResult } from './types.js';

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

  constructor() {
    this.rateLimiter = new RateLimiter(config, logger);
    this.rateLimiter.configure({
      maxRequests: getServerConfig().geoRateLimitPerMin,
      windowMs: 60_000,
      cleanupInterval: 0,
      errorMessage:
        'Geolocation lookups are rate-limited to stay within the provider quota. Retry in {waitTime}.',
    });
  }

  /** Resolve a hostname to its first A/AAAA address; pass IPs through unchanged. */
  private async resolveTarget(target: string, ctx: Context): Promise<string> {
    if (isIP(target) !== 0) return target;
    try {
      const { address } = await lookup(target);
      return address;
    } catch {
      throw validationError(`Hostname "${target}" did not resolve.`, {
        reason: 'unresolvable_host',
        ...ctx.recoveryFor('unresolvable_host'),
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

    if (isPrivateOrReservedIp(resolvedIp)) {
      throw validationError(
        `${target} resolves to private/reserved address ${resolvedIp}, which has no public geolocation.`,
        { reason: 'private_target', ...ctx.recoveryFor('private_target') },
      );
    }

    const cached = this.cache.get(resolvedIp);
    if (cached && cached.expiresAt > Date.now()) {
      ctx.log.debug('Geo cache hit', { resolvedIp });
      return { ...cached.result, target };
    }

    // Throttle only actual provider calls — cache hits above never reach the
    // upstream. Throws a RateLimited error when the per-minute budget is spent.
    this.rateLimiter.check(RATE_LIMIT_KEY);

    const url = new URL(`/json/${encodeURIComponent(resolvedIp)}`, cfg.geoBaseUrl);
    url.searchParams.set('fields', IP_API_FIELDS);
    if (cfg.geoApiKey) url.searchParams.set('key', cfg.geoApiKey);

    // Build a correlated open-bag RequestContext for the network/log utilities
    // (they take RequestContext, which the handler-facing Context isn't assignable
    // to). Forward the correlation fields as a plain bag.
    const reqCtx = requestContextService.createRequestContext({
      operation: 'GeoService.lookup',
      parentContext: { requestId: ctx.requestId, tenantId: ctx.tenantId, traceId: ctx.traceId },
    });

    let raw: IpApiResponse;
    try {
      raw = await withRetry(
        async () => {
          const response = await fetchWithTimeout(url.toString(), 8000, reqCtx, {
            signal: ctx.signal,
          });
          return (await response.json()) as IpApiResponse;
        },
        {
          operation: 'GeoService.lookup',
          context: reqCtx,
          baseDelayMs: 1500,
          signal: ctx.signal,
        },
      );
    } catch (err) {
      // Caller cancellation isn't a provider failure — let it bubble unchanged.
      if (ctx.signal.aborted) throw err;
      // The framework fetch error carries the provider URL, requestId, HTTP
      // status, and up to 500 bytes of the upstream response body in its `data`.
      // Re-throw a clean ServiceUnavailable so none of that reaches the client;
      // the original is preserved as `cause` for server-side logs/telemetry only.
      ctx.log.error(
        'Geo provider request failed',
        err instanceof Error ? err : new Error(String(err)),
        { resolvedIp },
      );
      throw serviceUnavailable(
        `Geolocation provider "${GEO_PROVIDER}" is unavailable. Try again shortly.`,
        undefined,
        { cause: err },
      );
    }

    if (raw.status === 'fail') {
      // Provider classified the IP itself as unlocatable (reserved/bogon/unrouted).
      // This will never succeed on retry, so surface it as a (non-retryable)
      // validation error. The target passed the private-range guard, so it is a
      // public-format address — the recovery hint must NOT imply the caller
      // failed to pass a public IP (it reads oddly for e.g. TEST-NET ranges).
      throw validationError(
        `Geolocation provider could not locate ${resolvedIp}: ${boundedField(raw.message) ?? 'unknown reason'}.`,
        {
          reason: 'private_target',
          retryable: false,
          recovery: {
            hint: 'This address has no public geolocation (it is reserved, unrouted, or bogon). Use a routable public IP.',
          },
        },
      );
    }

    const result = this.normalize(raw, target, resolvedIp);
    this.cacheSet(resolvedIp, { result, expiresAt: Date.now() + cfg.geoCacheTtlSeconds * 1000 });
    ctx.log.info('Geo lookup', { resolvedIp, country: result.countryCode ?? 'unknown' });
    return result;
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
 * reads `getServerConfig()` lazily and caches in memory, so it needs neither
 * core config nor storage.
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
