/**
 * @fileoverview Tests for GeoService — the one external dependency. The upstream
 * ip-api provider is stubbed at the global `fetch` boundary (the service calls
 * fetchWithTimeout WITHOUT rejectPrivateIPs, so no real DNS/network is touched),
 * and node:dns/promises is mocked for hostname resolution. Covers the happy path,
 * sparse upstream payloads, hostname → resolvedIp echo, the bounded cache, fixed
 * provenance, the bound-and-strip of provider-supplied strings, and every
 * failure reason (unresolvable_host, private_target via guard and via provider
 * envelope), plus the sanitized non-OK upstream response — asserting no upstream
 * internals (URL, status, response body, requestId) reach the client.
 * @module tests/services/geo-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import {
  GEO_CACHE_MAX_ENTRIES,
  GEO_FIELD_MAX_LENGTH,
  getGeoService,
  initGeoService,
} from '@/services/geo/geo-service.js';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

/** Build a Response-like object carrying the given JSON body and status. */
const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

/** A complete ip-api success payload for a public IP (8.8.8.8 → Google). */
const FULL_PAYLOAD = {
  status: 'success',
  country: 'United States',
  countryCode: 'US',
  regionName: 'California',
  city: 'Mountain View',
  lat: 37.4056,
  lon: -122.0775,
  timezone: 'America/Los_Angeles',
  isp: 'Google LLC',
  org: 'Google Public DNS',
  as: 'AS15169 Google LLC',
  query: '8.8.8.8',
};

const lookup = (target: string) => getGeoService().lookup(target, createMockContext());

describe('GeoService', () => {
  beforeEach(() => {
    resetServerConfig();
    initGeoService();
    lookupMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it('normalizes a full upstream payload for a public IP', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD)));
    const result = await lookup('8.8.8.8');
    expect(result).toMatchObject({
      target: '8.8.8.8',
      resolvedIp: '8.8.8.8',
      country: 'United States',
      countryCode: 'US',
      region: 'California',
      city: 'Mountain View',
      latitude: 37.4056,
      longitude: -122.0775,
      timezone: 'America/Los_Angeles',
      asn: 'AS15169',
      source: 'ip-api',
    });
    // `org` prefers the dedicated org field over the isp / as-derived org.
    expect(result.org).toBe('Google Public DNS');
  });

  it('does not call the resolver for a raw IP target', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD)));
    await lookup('8.8.8.8');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('preserves missing upstream fields as absent (never fabricated)', async () => {
    // Reserved/thin range: provider reports country only, omits the rest entirely.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          status: 'success',
          country: 'Australia',
          countryCode: 'AU',
          query: '1.1.1.1',
        }),
      ),
    );
    const result = await lookup('1.1.1.1');
    expect(result.country).toBe('Australia');
    expect(result.countryCode).toBe('AU');
    // Omitted fields stay undefined, not null or a fabricated default.
    expect(result.region).toBeUndefined();
    expect(result.city).toBeUndefined();
    expect(result.latitude).toBeUndefined();
    expect(result.longitude).toBeUndefined();
    expect(result.asn).toBeUndefined();
    expect(result.org).toBeUndefined();
    expect(result.timezone).toBeUndefined();
    expect(result).not.toHaveProperty('latitude');
  });

  it('falls back to isp for org when the dedicated org field is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ status: 'success', isp: 'Cloudflare, Inc.', query: '1.0.0.1' }),
        ),
    );
    const result = await lookup('1.0.0.1');
    expect(result.org).toBe('Cloudflare, Inc.');
  });

  it('splits the ip-api `as` token into asn + org when org/isp are absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ status: 'success', as: 'AS13335 Cloudflare', query: '1.0.0.1' }),
        ),
    );
    const result = await lookup('1.0.0.1');
    expect(result.asn).toBe('AS13335');
    expect(result.org).toBe('Cloudflare');
  });

  it('resolves a hostname and echoes the resolved IP', async () => {
    lookupMock.mockResolvedValue({ address: '8.8.8.8', family: 4 });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    const result = await lookup('dns.google');
    expect(lookupMock).toHaveBeenCalledWith('dns.google');
    expect(result.target).toBe('dns.google'); // echoes the supplied target
    expect(result.resolvedIp).toBe('8.8.8.8'); // but reports which IP was located
    // The provider is queried for the resolved IP, never the hostname.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('8.8.8.8');
  });

  it('throws unresolvable_host when a hostname does not resolve', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    vi.stubGlobal('fetch', vi.fn());
    await expect(lookup('no-such-host.invalid')).rejects.toMatchObject({
      data: { reason: 'unresolvable_host' },
    });
  });

  it('throws private_target for an IP in a reserved range before any upstream call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(lookup('10.0.0.1')).rejects.toMatchObject({
      data: { reason: 'private_target' },
    });
    // Guard fires pre-fetch — the provider is never contacted for a private IP.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws private_target when a hostname resolves into a private range', async () => {
    // A hostname can smuggle a private IP past the schema; the guard runs AFTER DNS.
    lookupMock.mockResolvedValue({ address: '192.168.1.10', family: 4 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(lookup('db.internal.example.com')).rejects.toMatchObject({
      data: { reason: 'private_target' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws private_target when the provider returns a fail envelope', async () => {
    // A routable public IP (passes the private-range guard) that the provider
    // itself classifies as unlocatable via a fail envelope. The conventional
    // documentation ranges (203.0.113.0/24 etc.) are now caught by the guard
    // before any upstream call, so this path needs a genuinely public address.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ status: 'fail', message: 'reserved range', query: '0.0.0.1' }),
        ),
    );
    const error = await lookup('45.33.32.156').catch((e: unknown) => e);
    expect(error).toMatchObject({ data: { reason: 'private_target', retryable: false } });
    // The target passed the private-range guard, so it is a public-format
    // address — the recovery hint must NOT tell the caller to pass a public IP.
    const hint = (error as { data?: { recovery?: { hint?: string } } }).data?.recovery?.hint ?? '';
    expect(hint).not.toMatch(/pass a public ip/i);
    expect(hint).toMatch(/no public geolocation/i);
  });

  it('caches by resolved IP — a repeat lookup does not re-call the provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    await lookup('8.8.8.8');
    await lookup('8.8.8.8');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not serve cache across TTL=0 (cache disabled)', async () => {
    vi.stubEnv('TOOLKIT_GEO_CACHE_TTL_SECONDS', '0');
    resetServerConfig();
    initGeoService();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    await lookup('8.8.8.8');
    await lookup('8.8.8.8');
    // expiresAt = now + 0 is not strictly greater than a later now → re-fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throttles outbound provider calls per TOOLKIT_GEO_RATE_LIMIT_PER_MIN', async () => {
    vi.stubEnv('TOOLKIT_GEO_RATE_LIMIT_PER_MIN', '2');
    resetServerConfig();
    initGeoService();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    // Distinct public IPs so the cache never short-circuits a provider call.
    await lookup('8.8.8.8');
    await lookup('8.8.4.4');
    // The third lookup blows the per-minute budget → RateLimited before any fetch.
    const error = await lookup('1.1.1.1').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sanitizes a non-OK upstream response — no upstream internals reach the client', async () => {
    vi.useFakeTimers();
    try {
      // fetchWithTimeout maps a non-OK Response to an McpError carrying the URL,
      // status, and response body; withRetry treats a 503 as transient and
      // retries with backoff — advance timers so it resolves fast. The service
      // must re-throw a clean ServiceUnavailable that leaks none of that.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse({ secret: 'upstream-body-should-not-leak' }, 503)),
      );
      const promise = lookup('8.8.8.8');
      const settled = promise.catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const error = (await settled) as { code?: number; message?: string; data?: unknown };
      // ServiceUnavailable, generic provider-named message — no URL/IP/status/body.
      expect(error.message).toMatch(/geolocation provider .* is unavailable/i);
      expect(error.message).not.toMatch(/8\.8\.8\.8|http|status|503|secret/i);
      // No leaky `data`: requestId, statusCode, responseBody, internal operation
      // name must all be absent (the framework fetch error carries them).
      const data = (error.data ?? {}) as Record<string, unknown>;
      expect(data).not.toHaveProperty('statusCode');
      expect(data).not.toHaveProperty('responseBody');
      expect(data).not.toHaveProperty('requestId');
      expect(data).not.toHaveProperty('operation');
      expect(JSON.stringify(data)).not.toMatch(/upstream-body-should-not-leak/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an upstream 500 and returns the subsequent success', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ message: 'temporary failure' }, { status: 500 }))
        .mockResolvedValueOnce(Response.json(FULL_PAYLOAD));
      vi.stubGlobal('fetch', fetchMock);
      const pending = lookup('8.8.8.8');
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ resolvedIp: '8.8.8.8', countryCode: 'US' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry an upstream 501 and sanitizes the failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ secret: 'upstream detail' }, { status: 501 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(lookup('8.8.8.8')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'Geolocation provider "ip-api" is unavailable. Try again shortly.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps upstream provider detail out of the client-visible log sink', async () => {
    // `ctx.log` is dual-sink: every call also emits `notifications/message` to
    // the client, and an error call puts `error.message` on that wire payload.
    // The framework's fetch error reads "<provider-host> returned HTTP 503 ..." —
    // the same provenance the thrown ServiceUnavailable deliberately strips, so
    // handing the raw error to `ctx.log` would route it around the sanitizer.
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse({ secret: 'upstream-body-should-not-leak' }, 503)),
      );
      const ctx = createMockContext();
      const errorSpy = vi.spyOn(ctx.log, 'error');
      const settled = getGeoService()
        .lookup('8.8.8.8', ctx)
        .catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      await settled;

      for (const [msg, err, data] of errorSpy.mock.calls) {
        // Mirrors how the framework composes the notification payload.
        const wire = JSON.stringify({
          message: msg,
          ...((data as Record<string, unknown>) ?? {}),
          ...(err ? { error: (err as Error).message } : {}),
        });
        expect(wire).not.toMatch(/ip-api|returned HTTP|503|upstream-body-should-not-leak/i);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors a provider base URL + API key from config', async () => {
    vi.stubEnv('TOOLKIT_GEO_BASE_URL', 'https://pro.ip-api.example');
    vi.stubEnv('TOOLKIT_GEO_API_KEY', 'secret-key');
    resetServerConfig();
    initGeoService();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    await lookup('8.8.8.8');
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('pro.ip-api.example');
    expect(calledUrl).toContain('key=secret-key');
  });

  it('rejects a hex-form IPv4-mapped private target locally, without contacting the provider', async () => {
    // The dotted spelling (::ffff:127.0.0.1) has always been rejected here; the
    // hex tail carries the same 32 bits and must not reach the provider either.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(lookup('::ffff:7f00:1')).rejects.toMatchObject({
      data: { reason: 'private_target' },
    });
    await expect(lookup('::ffff:a9fe:a9fe')).rejects.toMatchObject({
      data: { reason: 'private_target' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds cache growth across distinct resolved IPs, evicting the oldest entry', async () => {
    // The rate limiter throttles provider calls, not cache entries — raise it so
    // the cap under test is the cache bound and nothing else.
    vi.stubEnv('TOOLKIT_GEO_RATE_LIMIT_PER_MIN', String(GEO_CACHE_MAX_ENTRIES * 2));
    resetServerConfig();
    initGeoService();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);

    // 9.0.0.0/8 is routable public space, so every address clears the guard.
    const ipAt = (i: number) => `9.0.${(i >> 8) & 0xff}.${i & 0xff}`;
    for (let i = 0; i < GEO_CACHE_MAX_ENTRIES; i++) await lookup(ipAt(i));
    expect(fetchMock).toHaveBeenCalledTimes(GEO_CACHE_MAX_ENTRIES);

    // At exactly the cap nothing has been dropped yet — the first IP still hits.
    await lookup(ipAt(0));
    expect(fetchMock).toHaveBeenCalledTimes(GEO_CACHE_MAX_ENTRIES);

    // One entry past the cap evicts the oldest rather than growing the Map.
    const overflowIp = ipAt(GEO_CACHE_MAX_ENTRIES);
    await lookup(overflowIp);
    expect(fetchMock).toHaveBeenCalledTimes(GEO_CACHE_MAX_ENTRIES + 1);

    // The evicted first IP re-fetches; the newest entry is still resident.
    await lookup(ipAt(0));
    expect(fetchMock).toHaveBeenCalledTimes(GEO_CACHE_MAX_ENTRIES + 2);
    await lookup(overflowIp);
    expect(fetchMock).toHaveBeenCalledTimes(GEO_CACHE_MAX_ENTRIES + 2);
  });

  it('reports ip-api as the source regardless of any ambient provider env var', async () => {
    vi.stubEnv('TOOLKIT_GEO_PROVIDER', 'claimed-alternate-provider');
    resetServerConfig();
    initGeoService();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD)));
    const result = await lookup('8.8.8.8');
    expect(result.source).toBe('ip-api');
  });

  it('names ip-api in the sanitized provider-failure message, never an env value', async () => {
    vi.stubEnv('TOOLKIT_GEO_PROVIDER', 'claimed-alternate-provider');
    resetServerConfig();
    initGeoService();
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 503)));
      const settled = lookup('8.8.8.8').catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const error = (await settled) as { message?: string };
      expect(error.message).toContain('ip-api');
      expect(error.message).not.toContain('claimed-alternate-provider');
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces the ip-api proxy / hosting / mobile flags', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ ...FULL_PAYLOAD, proxy: true, hosting: true, mobile: false }),
        ),
    );
    const result = await lookup('8.8.8.8');
    expect(result.proxy).toBe(true);
    expect(result.hosting).toBe(true);
    expect(result.mobile).toBe(false);
  });

  it('requests the proxy / hosting / mobile fields from the provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    await lookup('8.8.8.8');
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('proxy');
    expect(calledUrl).toContain('hosting');
    expect(calledUrl).toContain('mobile');
  });

  it('leaves the proxy / hosting / mobile flags undefined when the provider omits them', async () => {
    // FULL_PAYLOAD carries none of the three — absence must not become `false`.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD)));
    const result = await lookup('8.8.8.8');
    expect(result.proxy).toBeUndefined();
    expect(result.hosting).toBeUndefined();
    expect(result.mobile).toBeUndefined();
    expect(result).not.toHaveProperty('proxy');
  });

  it('bounds and strips provider-supplied strings before they enter the result', async () => {
    const oversized = 'A'.repeat(GEO_FIELD_MAX_LENGTH * 4);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 'success',
        country: 'United\u000aStates\u0000',
        countryCode: 'US',
        regionName: 'Cali\u001bfornia',
        city: 'Mountain\u000d\u000aView',
        timezone: 'America/Los_Angeles',
        org: oversized,
        as: `AS15169 ${oversized}`,
        query: '8.8.8.8',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await lookup('8.8.8.8');

    expect(result.org?.length).toBe(GEO_FIELD_MAX_LENGTH);
    expect(result.asn).toBe('AS15169');
    // Control characters and newlines never reach the model-facing surfaces.
    const strings = [result.country, result.region, result.city, result.org, result.asn].join('|');
    expect(strings).not.toMatch(/[\u0000-\u001f\u007f]/);
    // A control run collapses to a single space, so words stay separated rather
    // than being welded together by a bare strip.
    expect(result.country).toBe('United States');
    expect(result.region).toBe('Cali fornia');
    expect(result.city).toBe('Mountain View');

    // The cached entry holds the bounded values, not the raw oversized payload.
    const cached = await lookup('8.8.8.8');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cached.org?.length).toBe(GEO_FIELD_MAX_LENGTH);
  });

  it('bounds the provider fail-envelope message before it reaches the client', async () => {
    const oversized = `reserved range \u000a\u000a# Injected heading ${'C'.repeat(GEO_FIELD_MAX_LENGTH * 4)}`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ status: 'fail', message: oversized, query: '45.33.32.156' }),
        ),
    );
    const error = (await lookup('45.33.32.156').catch((e: unknown) => e)) as { message: string };
    expect(error.message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(error.message.length).toBeLessThan(GEO_FIELD_MAX_LENGTH * 2);
  });

  it('bounds the asn fallback path when `as` does not match the AS<digits> pattern', async () => {
    const oversized = `not-an-asn ${'B'.repeat(GEO_FIELD_MAX_LENGTH * 4)}`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ status: 'success', as: oversized, query: '8.8.8.8' })),
    );
    const result = await lookup('8.8.8.8');
    expect(result.asn?.length).toBe(GEO_FIELD_MAX_LENGTH);
    expect(result.asn).toBe(oversized.slice(0, GEO_FIELD_MAX_LENGTH));
  });
});

describe('getGeoService (uninitialized)', () => {
  it('throws a clear error when init was skipped', async () => {
    vi.resetModules();
    const { getGeoService: freshGet } = await import('@/services/geo/geo-service.js');
    expect(() => freshGet()).toThrow(/not initialized/);
  });
});
