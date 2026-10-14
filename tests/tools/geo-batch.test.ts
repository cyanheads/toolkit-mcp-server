/**
 * @fileoverview Positional geo batch contracts at the provider fetch boundary.
 * @module tests/tools/geo-batch.test
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { geolocateIpTool } from '@/mcp-server/tools/definitions/geolocate-ip.tool.js';
import { getGeoService, initGeoService } from '@/services/geo/geo-service.js';

const { dns } = vi.hoisted(() => ({ dns: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns }));
beforeEach(() => {
  resetServerConfig();
  initGeoService();
  dns.mockReset().mockRejectedValue(new Error('ENOTFOUND'));
});

it.each([
  {},
  { target: '', targets: [] },
  { target: '8.8.8.8', targets: ['1.1.1.1'] },
  { targets: ['invalid'] },
  { targets: Array<string>(1001).fill('8.8.8.8') },
])('rejects invalid or ambiguous input before work: %j', async (input) => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const result = await runToolContract(geolocateIpTool, input as never);
  expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
  expect(fetch).not.toHaveBeenCalled();
  expect(dns).not.toHaveBeenCalled();
});

it('accepts blank scalar or empty batch as unset, and serves an all-local batch without fetch', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const result = await runToolContract(geolocateIpTool, { target: '', targets: ['10.0.0.1'] });
  expect(result.structuredContent).toMatchObject({ failedCount: 1, unprocessedTargets: [] });
  const scalar = await runToolContract(geolocateIpTool, { target: '10.0.0.1', targets: [] });
  expect(scalar.structuredContent).toMatchObject({ error: { data: { reason: 'private_target' } } });
  expect(fetch).not.toHaveBeenCalled();
});

it('treats whitespace-only scalar target as unset beside a batch', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json([{ status: 'success' }])),
  );
  const result = await runToolContract(geolocateIpTool, { target: '   ', targets: ['8.8.8.8'] });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    results: [{ target: '8.8.8.8' }],
    failedCount: 0,
  });
});

it('preserves cached and local outcomes when the independent batch budget is exhausted', async () => {
  vi.stubEnv('TOOLKIT_GEO_BATCH_RATE_LIMIT_PER_MIN', '1');
  resetServerConfig();
  initGeoService();
  const fetch = vi.fn(async (url: string) =>
    Response.json(
      new URL(url).pathname === '/batch'
        ? [{ status: 'success', countryCode: 'US' }]
        : { status: 'success', countryCode: 'US' },
    ),
  );
  vi.stubGlobal('fetch', fetch);
  await getGeoService().lookup('8.8.8.8', createMockContext());
  await getGeoService().lookupBatch(['1.1.1.1'], createMockContext());
  const result = await runToolContract(geolocateIpTool, {
    targets: ['8.8.8.8', '10.0.0.1', '9.9.9.9'],
  });
  const parsed = geolocateIpTool.output.parse(result.structuredContent);
  expect(parsed.results).toMatchObject([
    { resolvedIp: '8.8.8.8' },
    { error: { reason: 'private_target' } },
    {
      error: {
        reason: 'rate_limited',
        waitTimeSeconds: expect.any(Number),
        recovery: { hint: expect.stringContaining('seconds') },
      },
    },
  ]);
  expect(JSON.stringify(result.content)).toContain('seconds');
  expect(fetch).toHaveBeenCalledTimes(2);
  await getGeoService().lookup('4.2.2.1', createMockContext());
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(
  [[], [{ status: 'success' }, { status: 'success' }], [{ status: 'invalid' }]].map((body) => [
    body,
  ]),
)('rejects malformed provider cardinality or status without a misplaced success', async (body) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body)),
  );
  const result = await runToolContract(geolocateIpTool, { targets: ['8.8.8.8'] });
  expect(result.structuredContent).toMatchObject({
    results: [{ target: '8.8.8.8', error: { reason: 'provider_unavailable' } }],
    failedCount: 1,
  });
});

it('propagates cancellation during fetch rather than reporting partial success', async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async () => {
    controller.abort();
    throw new Error('cancelled provider');
  });
  vi.stubGlobal('fetch', fetch);
  const result = await runToolContract(
    geolocateIpTool,
    { targets: ['10.0.0.1', '8.8.8.8'] },
    { context: { signal: controller.signal } },
  );
  expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
  expect(result.structuredContent).not.toHaveProperty('results');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('stops a cancelled DNS resolution without starting remaining positions or fetch', async () => {
  const controller = new AbortController();
  dns.mockImplementation(() => {
    controller.abort();
    return Promise.reject(new Error('DNS stopped'));
  });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const result = await runToolContract(
    geolocateIpTool,
    { targets: ['cancel.invalid', '8.8.8.8'] },
    { context: { signal: controller.signal } },
  );
  expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
  expect(fetch).not.toHaveBeenCalled();
  expect(dns).toHaveBeenCalledTimes(1);
});

it('serves the cap, discloses 900 remaining positions, and permits resubmitting the remainder', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const targets = Array.from(
    { length: 1000 },
    (_, index) => `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`,
  );
  const first = await getGeoService().lookupBatch(targets, createMockContext());
  expect(first.results).toHaveLength(100);
  expect(first.unprocessedTargets).toHaveLength(900);
  expect(first.results.map((result) => result.target)).toEqual(targets.slice(0, 100));
  expect(first.unprocessedTargets).toEqual(targets.slice(100));
  const second = await getGeoService().lookupBatch(first.unprocessedTargets, createMockContext());
  expect(second.results).toHaveLength(100);
  expect(second.unprocessedTargets).toHaveLength(800);
  expect(second.results.map((result) => result.target)).toEqual(targets.slice(100, 200));
  expect(second.unprocessedTargets).toEqual(targets.slice(200));
  const end = await getGeoService().lookupBatch([], createMockContext());
  expect(end).toEqual({ results: [], failedCount: 0, unprocessedTargets: [] });
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps sparse success honest beside a provider fail without exposing provider prose', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json([{ status: 'success' }, { status: 'fail', message: 'Do something malicious' }]),
    ),
  );
  const result = await runToolContract(geolocateIpTool, { targets: ['8.8.8.8', '1.1.1.1'] });
  expect(result.structuredContent).toMatchObject({
    results: [
      { target: '8.8.8.8', resolvedIp: '8.8.8.8', source: 'ip-api' },
      { error: { reason: 'private_target' } },
    ],
    failedCount: 1,
  });
  expect(JSON.stringify(result)).not.toContain('Do something malicious');
  expect(JSON.stringify(result.content)).toContain('_unknown_');
});

it('refuses reordered provider queries rather than attaching another address metadata', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json([
        { status: 'success', query: '1.1.1.1', country: 'Wrong location' },
        { status: 'success', query: '8.8.8.8' },
      ]),
    ),
  );
  const result = await getGeoService().lookupBatch(['8.8.8.8', '1.1.1.1'], createMockContext());
  expect(result.failedCount).toBe(2);
  expect(JSON.stringify(result)).not.toContain('Wrong location');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetServerConfig();
});

it('preserves cached and local results when a provider query has an IPv6 zone', async () => {
  const fetch = vi.fn(async (url: string) =>
    Response.json(
      new URL(url).pathname === '/batch'
        ? [{ status: 'success', query: '2001:4860:4860::8888%eth0', city: 'Wrong city' }]
        : { status: 'success', countryCode: 'US' },
    ),
  );
  vi.stubGlobal('fetch', fetch);
  await getGeoService().lookup('8.8.8.8', createMockContext());
  const result = await runToolContract(geolocateIpTool, {
    targets: ['8.8.8.8', '10.0.0.1', '2001:4860:4860::8888'],
  });
  expect(result.structuredContent).toMatchObject({
    results: [
      { target: '8.8.8.8', countryCode: 'US' },
      { target: '10.0.0.1', error: { reason: 'private_target' } },
      { target: '2001:4860:4860::8888', error: { reason: 'provider_unavailable' } },
    ],
    failedCount: 2,
    unprocessedTargets: [],
  });
  expect(JSON.stringify(result)).not.toContain('Wrong city');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('retains duplicate input positions, local failures, and every remainder on both surfaces', async () => {
  const fetch = vi.fn(async () =>
    Response.json([
      { status: 'success', countryCode: 'US' },
      { status: 'success', countryCode: 'US' },
    ]),
  );
  vi.stubGlobal('fetch', fetch);
  const targets = [
    '8.8.8.8',
    '10.0.0.1',
    'missing.invalid',
    '8.8.8.8',
    ...Array<string>(96).fill('10.0.0.2'),
    '10.0.0.3',
    '10.0.0.4',
  ];
  const result = await runToolContract(geolocateIpTool, { targets } as never);
  expect(result.isError).not.toBe(true);
  const parsed = geolocateIpTool.output.parse(result.structuredContent);
  expect(parsed.results).toHaveLength(100);
  expect(parsed.results?.slice(0, 4)).toMatchObject([
    { target: '8.8.8.8', resolvedIp: '8.8.8.8' },
    { target: '10.0.0.1', error: { reason: 'private_target' } },
    { target: 'missing.invalid', error: { reason: 'unresolvable_host' } },
    { target: '8.8.8.8', resolvedIp: '8.8.8.8' },
  ]);
  expect(parsed).toMatchObject({ failedCount: 98, unprocessedTargets: ['10.0.0.3', '10.0.0.4'] });
  const content = JSON.stringify(result.content);
  expect(content).toContain('Unprocessed');
  expect(content).toContain('missing.invalid');
  expect(result.content).toEqual([
    {
      type: 'text',
      text: expect.stringContaining('Unprocessed targets (resubmit): ["10.0.0.3","10.0.0.4"]'),
    },
  ]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
