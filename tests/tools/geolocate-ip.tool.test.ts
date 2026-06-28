/**
 * @fileoverview Tests for toolkit_geolocate_ip — the tool-layer contract over
 * GeoService: input validation (NetworkTargetSchema), the declared error reasons
 * bubbling from the service (unresolvable_host, private_target), output schema
 * conformance, and the format() render (including sparse-field "unknown" honesty).
 * The upstream provider is stubbed at the global `fetch` boundary; no live network.
 * @module tests/tools/geolocate-ip.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { geolocateIpTool } from '@/mcp-server/tools/definitions/geolocate-ip.tool.js';
import { initGeoService } from '@/services/geo/geo-service.js';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const FULL_PAYLOAD = {
  status: 'success',
  country: 'United States',
  countryCode: 'US',
  regionName: 'California',
  city: 'Mountain View',
  lat: 37.4056,
  lon: -122.0775,
  timezone: 'America/Los_Angeles',
  org: 'Google LLC',
  as: 'AS15169 Google LLC',
  query: '8.8.8.8',
};

const run = (args: unknown) =>
  geolocateIpTool.handler(
    geolocateIpTool.input.parse(args),
    createMockContext({ errors: geolocateIpTool.errors }),
  );

describe('toolkit_geolocate_ip', () => {
  beforeEach(() => {
    resetServerConfig();
    initGeoService();
    lookupMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetServerConfig();
  });

  it('returns a normalized result for a public IP', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD)));
    const result = await run({ target: '8.8.8.8' });
    expect(result).toMatchObject({
      target: '8.8.8.8',
      resolvedIp: '8.8.8.8',
      countryCode: 'US',
      source: 'ip-api',
    });
  });

  it('output conforms to the declared schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD)));
    const result = await run({ target: '8.8.8.8' });
    expect(result).toEqual(expect.schemaMatching(geolocateIpTool.output));
  });

  it('bubbles private_target with the declared ValidationError code for a reserved-range target', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(run({ target: '10.0.0.1' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'private_target' },
    });
  });

  it('bubbles unresolvable_host with the declared ValidationError code when a hostname fails DNS', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    vi.stubGlobal('fetch', vi.fn());
    await expect(run({ target: 'no-such-host.invalid' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'unresolvable_host' },
    });
  });

  it.each([
    'metadata', // bare single-label — could alias an internal name
    'localhost',
    '', // missing/empty
    'has spaces.com',
    'http://example.com', // a URL, not a target
  ])('rejects invalid target %j at the schema boundary', (target) => {
    expect(geolocateIpTool.input.safeParse({ target }).success).toBe(false);
  });

  it('rejects a missing target field', () => {
    expect(geolocateIpTool.input.safeParse({}).success).toBe(false);
  });
});

describe('toolkit_geolocate_ip format()', () => {
  it('renders every populated field the model needs', () => {
    const blocks = geolocateIpTool.format!({
      target: 'dns.google',
      resolvedIp: '8.8.8.8',
      country: 'United States',
      countryCode: 'US',
      region: 'California',
      city: 'Mountain View',
      latitude: 37.4056,
      longitude: -122.0775,
      asn: 'AS15169',
      org: 'Google LLC',
      timezone: 'America/Los_Angeles',
      source: 'ip-api',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('dns.google');
    expect(text).toContain('8.8.8.8');
    expect(text).toContain('Mountain View');
    expect(text).toContain('California');
    expect(text).toContain('United States');
    expect(text).toContain('37.4056, -122.0775');
    expect(text).toContain('AS15169');
    expect(text).toContain('Google LLC');
    expect(text).toContain('America/Los_Angeles');
    expect(text).toContain('US');
    expect(text).toContain('ip-api');
  });

  it('renders unknown for absent fields instead of fabricating values', () => {
    // Sparse result: only country + resolvedIp known, the rest omitted.
    const blocks = geolocateIpTool.format!({
      target: '203.0.113.7',
      resolvedIp: '203.0.113.7',
      country: 'Australia',
      source: 'ip-api',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('_unknown_'); // explicit unknown marker
    // Honest absence — no invented coordinates or ASN.
    expect(text).not.toMatch(/Coordinates:\*\* [\d-]/);
    expect(text).toContain('**ASN:** _unknown_');
  });
});
