/**
 * @fileoverview Tests for GeoService — the one external dependency. The upstream
 * ip-api provider is stubbed at the global `fetch` boundary (the service calls
 * fetchWithTimeout WITHOUT rejectPrivateIPs, so no real DNS/network is touched),
 * and node:dns/promises is mocked for hostname resolution. Covers the happy path,
 * sparse upstream payloads, hostname → resolvedIp echo, the cache, and every
 * failure reason (unresolvable_host, private_target via guard and via provider
 * envelope), plus the sanitized non-OK upstream response — asserting no upstream
 * internals (URL, status, response body, requestId) reach the client.
 * @module tests/services/geo-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { getGeoService, initGeoService } from '@/services/geo/geo-service.js';

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
    expect((fetchMock.mock.calls[0]?.[0] as string).toString()).toContain('8.8.8.8');
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
    // A public-looking IP the provider itself classifies as unlocatable.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ status: 'fail', message: 'reserved range', query: '0.0.0.1' }),
        ),
    );
    const error = await lookup('203.0.113.7').catch((e: unknown) => e);
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

  it('honors a provider base URL + API key from config', async () => {
    vi.stubEnv('TOOLKIT_GEO_BASE_URL', 'https://pro.ip-api.example');
    vi.stubEnv('TOOLKIT_GEO_API_KEY', 'secret-key');
    resetServerConfig();
    initGeoService();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    await lookup('8.8.8.8');
    const calledUrl = (fetchMock.mock.calls[0]?.[0] as string).toString();
    expect(calledUrl).toContain('pro.ip-api.example');
    expect(calledUrl).toContain('key=secret-key');
  });
});

describe('getGeoService (uninitialized)', () => {
  it('throws a clear error when init was skipped', async () => {
    vi.resetModules();
    const { getGeoService: freshGet } = await import('@/services/geo/geo-service.js');
    expect(() => freshGet()).toThrow(/not initialized/);
  });
});
