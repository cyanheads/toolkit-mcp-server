/**
 * @fileoverview GeoService — the one external dependency. DNS-resolves a hostname
 * to an IP, calls the configured IP-geolocation provider (keyless ip-api by
 * default) with retry/backoff, normalizes the sparse upstream payload, and caches
 * by resolved IP. The private-range guard runs AFTER resolution so a hostname
 * cannot smuggle a request to an internal IP.
 * @module services/geo/geo-service
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
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
  query?: string;
};

const IP_API_FIELDS =
  'status,message,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,query';

type CacheEntry = { result: GeoResult; expiresAt: number };

export class GeoService {
  /** In-memory TTL cache keyed by resolved IP. Geolocation is stable, so repeats are cheap. */
  private readonly cache = new Map<string, CacheEntry>();

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
        `Geolocation provider "${cfg.geoProvider}" is unavailable. Try again shortly.`,
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
        `Geolocation provider could not locate ${resolvedIp}: ${raw.message ?? 'unknown reason'}.`,
        {
          reason: 'private_target',
          retryable: false,
          recovery: {
            hint: 'This address has no public geolocation (it is reserved, unrouted, or bogon). Use a routable public IP.',
          },
        },
      );
    }

    const result = this.normalize(raw, target, resolvedIp, cfg.geoProvider);
    this.cache.set(resolvedIp, { result, expiresAt: Date.now() + cfg.geoCacheTtlSeconds * 1000 });
    ctx.log.info('Geo lookup', { resolvedIp, country: result.countryCode ?? 'unknown' });
    return result;
  }

  /** Map the raw ip-api payload to GeoResult, omitting absent fields (never fabricating). */
  private normalize(
    raw: IpApiResponse,
    target: string,
    resolvedIp: string,
    source: string,
  ): GeoResult {
    const result: GeoResult = { target, resolvedIp, source };
    if (raw.country) result.country = raw.country;
    if (raw.countryCode) result.countryCode = raw.countryCode;
    if (raw.regionName) result.region = raw.regionName;
    if (raw.city) result.city = raw.city;
    if (typeof raw.lat === 'number') result.latitude = raw.lat;
    if (typeof raw.lon === 'number') result.longitude = raw.lon;
    if (raw.timezone) result.timezone = raw.timezone;
    // ip-api's `as` is "AS15169 Google LLC" — split the ASN token from the org name.
    if (raw.as) {
      const match = raw.as.match(/^(AS\d+)\s*(.*)$/);
      const asn = match?.[1];
      result.asn = asn ?? raw.as;
      const orgFromAs = match?.[2]?.trim();
      if (orgFromAs) result.org = orgFromAs;
    }
    // Prefer the dedicated org field; fall back to isp; finally to the `as`-derived org.
    if (raw.org) result.org = raw.org;
    else if (raw.isp && !result.org) result.org = raw.isp;
    return result;
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
