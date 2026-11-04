/**
 * @fileoverview Tests for toolkit_geolocate_ip — the tool-layer contract over
 * GeoService: input validation (NetworkTargetSchema), the declared error reasons
 * bubbling from the service (unresolvable_host, private_target), output schema
 * conformance, and the format() render (including sparse-field "unknown" honesty
 * and provider strings reading back as written under a Markdown parse).
 * The upstream provider is stubbed at the global `fetch` boundary; no live network.
 * @module tests/tools/geolocate-ip.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { geolocateIpTool } from '@/mcp-server/tools/definitions/geolocate-ip.tool.js';
import { GEO_FIELD_MAX_LENGTH, initGeoService } from '@/services/geo/geo-service.js';
import { readCommonMark } from '../helpers/commonmark.js';
import { jsonResponse } from '../helpers/json-response.js';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

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
    vi.unstubAllEnvs();
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

  it('surfaces the provider quality flags and still conforms to the schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ ...FULL_PAYLOAD, proxy: true, hosting: true, mobile: false }),
        ),
    );
    const result = await run({ target: '8.8.8.8' });
    expect(result).toMatchObject({ proxy: true, hosting: true, mobile: false });
    expect(result).toEqual(expect.schemaMatching(geolocateIpTool.output));
  });

  it('reports ip-api as the source even with an ambient provider env var set', async () => {
    vi.stubEnv('TOOLKIT_GEO_PROVIDER', 'claimed-alternate-provider');
    resetServerConfig();
    initGeoService();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(FULL_PAYLOAD)));
    const result = await run({ target: '8.8.8.8' });
    expect(result.source).toBe('ip-api');
  });

  it('returns isp, asHolder, and asName beside org on both surfaces', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          status: 'success',
          country: 'Australia',
          countryCode: 'AU',
          org: 'APNIC and Cloudflare DNS Resolver project',
          isp: 'Cloudflare, Inc',
          as: 'AS13335 Cloudflare, Inc.',
          asname: 'CLOUDFLARENET',
          query: '1.1.1.1',
        }),
      ),
    );
    const result = await runToolContract(geolocateIpTool, { target: '1.1.1.1' });
    expect(geolocateIpTool.output.parse(result.structuredContent)).toMatchObject({
      org: 'APNIC and Cloudflare DNS Resolver project',
      isp: 'Cloudflare, Inc',
      asn: 'AS13335',
      asHolder: 'Cloudflare, Inc.',
      asName: 'CLOUDFLARENET',
    });
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(readCommonMark(text).split('\n')).toEqual(
      expect.arrayContaining([
        '⟨strong⟩ASN:⟨/strong⟩ AS13335 | ⟨strong⟩Org:⟨/strong⟩ APNIC and Cloudflare DNS Resolver project',
        '⟨strong⟩ISP:⟨/strong⟩ Cloudflare, Inc | ⟨strong⟩AS holder:⟨/strong⟩ Cloudflare, Inc. | ⟨strong⟩AS name:⟨/strong⟩ CLOUDFLARENET',
      ]),
    );
  });

  describe('single-target failure contract', () => {
    /** The contract `when` for private_target, which the advertised output schema carries. */
    const PRIVATE_WHEN =
      'The target resolves to a private/reserved IP, or to a public-format IP the provider reports as unlocatable (reserved, unrouted, or bogon); neither has public geolocation.';
    /** The contract `recovery`, the wire hint whenever a private_target throw names none. */
    const PRIVATE_RECOVERY =
      'This address is private, reserved, unrouted, or bogon, so it has no public geolocation. Pass a routable public IP address, or a hostname that resolves to one.';

    const contentOf = (content: { type: string; text?: string }[]) =>
      content
        .filter((block) => block.type === 'text')
        .map((block) => readCommonMark(block.text ?? ''))
        .join('\n');

    it('declares private_target for both the private-range guard and the provider fail status', () => {
      expect(geolocateIpTool.errors?.find((e) => e.reason === 'private_target')).toEqual({
        reason: 'private_target',
        code: JsonRpcErrorCode.ValidationError,
        when: PRIVATE_WHEN,
        recovery: PRIVATE_RECOVERY,
        thrownBy: 'service',
      });
    });

    it('fails a hostname that does not resolve as unresolvable_host with its recovery on both surfaces', async () => {
      lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const result = await runToolContract(geolocateIpTool, { target: 'no-such-host.invalid' });
      const hint = "Hostname didn't resolve. Verify it, or pass an IP address directly.";
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: 'Hostname "no-such-host.invalid" did not resolve.',
          data: { reason: 'unresolvable_host', recovery: { hint } },
        },
      });
      expect(contentOf(result.content)).toBe(
        `Error: Hostname "no-such-host.invalid" did not resolve.\n\nRecovery: ${hint}\n\n(reason unresolvable_host)`,
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it('fails a private-range target as private_target with the contract recovery on both surfaces', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const result = await runToolContract(geolocateIpTool, { target: '10.0.0.1' });
      const message = '10.0.0.1 is a private/reserved address, which has no public geolocation.';
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message,
          data: { reason: 'private_target', recovery: { hint: PRIVATE_RECOVERY } },
        },
      });
      expect(contentOf(result.content)).toBe(
        `Error: ${message}\n\nRecovery: ${PRIVATE_RECOVERY}\n\n(reason private_target)`,
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it('fails a public-format address the provider cannot locate as non-retryable private_target with its own recovery', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse({ status: 'fail', message: 'reserved range', query: '45.33.32.156' }),
          ),
      );
      const result = await runToolContract(geolocateIpTool, { target: '45.33.32.156' });
      const message = 'Geolocation provider could not locate 45.33.32.156.';
      const hint =
        'This address has no public geolocation (it is reserved, unrouted, or bogon). Use a routable public IP.';
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message,
          data: { reason: 'private_target', retryable: false, recovery: { hint } },
        },
      });
      expect(contentOf(result.content)).toBe(
        `Error: ${message}\n\nRecovery: ${hint}\n\n(reason private_target · not retryable)`,
      );
    });
  });

  it('carries a Markdown-shaped provider org verbatim in structuredContent and as text in content[]', async () => {
    const org = '[Verify your account](https://evil.example) *Acme* <b>Corp</b>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...FULL_PAYLOAD, org })));
    const result = await runToolContract(geolocateIpTool, { target: '8.8.8.8' });
    expect(geolocateIpTool.output.parse(result.structuredContent).org).toBe(org);
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(readCommonMark(text).split('\n')).toContain(
      `⟨strong⟩ASN:⟨/strong⟩ AS15169 | ⟨strong⟩Org:⟨/strong⟩ ${org}`,
    );
  });
});

describe('toolkit_geolocate_ip output schema', () => {
  const base = { target: '8.8.8.8', resolvedIp: '8.8.8.8', source: 'ip-api' };

  it.each([
    'country',
    'countryCode',
    'region',
    'city',
    'org',
    'asn',
    'timezone',
    'isp',
    'asHolder',
    'asName',
  ])('caps %s at the enforced ceiling', (field) => {
    const atCeiling = { ...base, [field]: 'x'.repeat(GEO_FIELD_MAX_LENGTH) };
    const overCeiling = { ...base, [field]: 'x'.repeat(GEO_FIELD_MAX_LENGTH + 1) };
    expect(geolocateIpTool.output.safeParse(atCeiling).success).toBe(true);
    expect(geolocateIpTool.output.safeParse(overCeiling).success).toBe(false);
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
      proxy: false,
      hosting: true,
      mobile: false,
      source: 'ip-api',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Proxy/VPN:** false');
    expect(text).toContain('**Hosting:** true');
    expect(text).toContain('**Mobile:** false');
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
    expect(text.split('\n')).toContain(
      '**ISP:** _unknown_ | **AS holder:** _unknown_ | **AS name:** _unknown_',
    );
    // A flag the provider never reported renders unknown, not a fabricated false.
    expect(text).toContain('**Proxy/VPN:** _unknown_');
    expect(text).toContain('**Hosting:** _unknown_');
    expect(text).toContain('**Mobile:** _unknown_');
  });

  it('renders plain provider values unchanged', () => {
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
      org: 'AT&T Services, Inc.',
      isp: 'Google LLC',
      asHolder: 'Google LLC',
      asName: 'GOOGLE',
      timezone: 'America/Los_Angeles',
      proxy: false,
      hosting: true,
      mobile: false,
      source: 'ip-api',
    });
    expect(blocks).toEqual([
      {
        type: 'text',
        text: [
          '**dns.google** → 8.8.8.8',
          '**Location:** Mountain View, California, United States',
          '**Coordinates:** 37.4056, -122.0775',
          '**Timezone:** America/Los_Angeles',
          '**ASN:** AS15169 | **Org:** AT&T Services, Inc.',
          '**ISP:** Google LLC | **AS holder:** Google LLC | **AS name:** GOOGLE',
          '**Country code:** US',
          '**Proxy/VPN:** false | **Hosting:** true | **Mobile:** false',
          '**Source:** ip-api',
        ].join('\n'),
      },
    ]);
  });
});

/** Every provider-supplied string field `format()` interpolates. */
const PROVIDER_STRING_FIELDS = [
  'country',
  'countryCode',
  'region',
  'city',
  'timezone',
  'asn',
  'org',
  'isp',
  'asHolder',
  'asName',
] as const;
type ProviderStringField = (typeof PROVIDER_STRING_FIELDS)[number];

/** Provider strings that parse as Markdown or raw HTML when interpolated as-is. */
const MARKDOWN_SHAPED_VALUES = [
  '[Verify your account](https://evil.example)',
  '*emphasis*',
  '_emphasis_',
  '<b>Corp</b>',
  'Acme `code` span',
  'A | B',
  'Acme #',
  ' Acme Corp ',
];

/** A plain word marking the slot a field's value renders into. */
const SLOT = 'Zqxvslot';

/** markdown-it's GFM-flavored preset with raw HTML on, the other parse the output must survive. */
const gfm = new MarkdownIt('default', { html: true });

const textOf = (blocks: ReturnType<NonNullable<typeof geolocateIpTool.format>>) =>
  blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

const withField = (field: ProviderStringField, value: string) =>
  ({ [field]: value }) as Partial<Record<ProviderStringField, string>>;

const renderSingle = (fields: Partial<Record<ProviderStringField, string>>) =>
  textOf(
    geolocateIpTool.format!({
      target: '8.8.8.8',
      resolvedIp: '8.8.8.8',
      source: 'ip-api',
      ...fields,
    }),
  );

const renderBatchRow = (fields: Partial<Record<ProviderStringField, string>>) =>
  textOf(
    geolocateIpTool.format!({
      results: [
        { target: '8.8.8.8', resolvedIp: '8.8.8.8', source: 'ip-api', ...fields },
        {
          target: '10.0.0.1',
          error: {
            reason: 'private_target',
            message: '10.0.0.1 is a private/reserved address, which has no public geolocation.',
            recovery: {
              hint: 'Private/reserved addresses have no public geolocation. Pass a public IP address.',
            },
          },
        },
      ],
      failedCount: 1,
      unprocessedTargets: [],
    }),
  );

/**
 * What a parse of the rendered block should read as: the same parse of the
 * block with a plain word in the field's slot, that word replaced by `expected`.
 * Every authored node around the slot (labels, `_unknown_`, line breaks) must
 * come back unchanged, and the slot must hold exactly the value.
 */
function slotReading(
  render: (fields: Partial<Record<ProviderStringField, string>>) => string,
  field: ProviderStringField,
  read: (markdown: string) => string,
  expected: string,
): string {
  const template = read(render(withField(field, SLOT)));
  expect(template.split(SLOT)).toHaveLength(2);
  return template.replace(SLOT, () => expected);
}

describe('toolkit_geolocate_ip format() provider-string escaping', () => {
  it('renders a Markdown link, emphasis, and HTML in org as literal text', () => {
    const text = renderSingle({
      org: '[Verify your account](https://evil.example) *Acme* <b>Corp</b>',
    });
    expect(text.split('\n')).toContain(
      '**ASN:** _unknown_ | **Org:** \\[Verify your account\\](https://evil.example) \\*Acme\\* \\<b>Corp\\</b>',
    );
    expect(readCommonMark(text).split('\n')).toContain(
      '⟨strong⟩ASN:⟨/strong⟩ ⟨em⟩unknown⟨/em⟩ | ⟨strong⟩Org:⟨/strong⟩ [Verify your account](https://evil.example) *Acme* <b>Corp</b>',
    );
  });

  describe.each([
    ['single result', renderSingle],
    ['batch row', renderBatchRow],
  ] as const)('in a %s', (_shape, render) => {
    it.each(PROVIDER_STRING_FIELDS)('reads every %s value back under CommonMark', (field) => {
      expect(
        MARKDOWN_SHAPED_VALUES.map((value) => readCommonMark(render(withField(field, value)))),
      ).toEqual(
        MARKDOWN_SHAPED_VALUES.map((value) => slotReading(render, field, readCommonMark, value)),
      );
    });

    it.each(PROVIDER_STRING_FIELDS)(
      'renders every %s value as text under markdown-it default with HTML on',
      (field) => {
        const html = (markdown: string) => gfm.render(markdown);
        expect(
          MARKDOWN_SHAPED_VALUES.map((value) => html(render(withField(field, value)))),
        ).toEqual(
          MARKDOWN_SHAPED_VALUES.map((value) =>
            slotReading(render, field, html, gfm.utils.escapeHtml(value)),
          ),
        );
      },
    );
  });
});
