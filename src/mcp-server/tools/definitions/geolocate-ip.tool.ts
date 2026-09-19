/**
 * @fileoverview toolkit_geolocate_ip — resolve a public IP (or hostname) to
 * geographic and network metadata via an external IP-geolocation API. Always-on:
 * the server calls the provider, never the target, so there is no SSRF surface.
 * @module mcp-server/tools/definitions/geolocate-ip.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { GEO_FIELD_MAX_LENGTH, getGeoService } from '@/services/geo/geo-service.js';
import { NetworkTargetSchema } from '@/services/network/target.js';

export const geolocateIpTool = tool('toolkit_geolocate_ip', {
  title: 'toolkit-mcp-server: geolocate IP',
  description:
    'Resolve a public IP address (or hostname) to geographic and network metadata: country, region, city, latitude/longitude, the owning ASN and organization, timezone, and the proxy/hosting/mobile quality flags. target accepts an IPv4/IPv6 address or a hostname — a hostname is DNS-resolved first and the resolvedIp field echoes which IP was actually located. The provider is called directly (never the target), so this is SSRF-free and safe to expose anywhere. Results are best-effort and provider-bounded: VPNs, proxies, mobile NAT, and anycast all defeat IP-to-location, accuracy is city-level at best, and many fields can be absent for reserved or thinly-documented ranges — absent fields are reported as unknown, never invented. Read proxy, hosting, and mobile before trusting the coordinates: a true on any of them means the location describes infrastructure, not the user. Private/reserved addresses have no public geolocation and are rejected. The source field names which provider answered.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    target: NetworkTargetSchema,
  }),
  /**
   * `target` takes an IP or a hostname, so a caller naturally reaches for the
   * narrower word for whichever one it holds. Each maps one-to-one onto the
   * single declared key; `inputSchema` is unchanged, so `target` is still what
   * the model is told to send.
   */
  inputAliases: { ip: 'target', hostname: 'target', host: 'target' },
  output: z.object({
    target: z.string().describe('The target as supplied (IP or hostname).'),
    resolvedIp: z
      .string()
      .describe(
        'The IP that was actually located (a supplied hostname is resolved to this first).',
      ),
    country: z
      .string()
      .max(GEO_FIELD_MAX_LENGTH)
      .optional()
      .describe('Country name. Absent when the provider does not report it.'),
    countryCode: z
      .string()
      .max(GEO_FIELD_MAX_LENGTH)
      .optional()
      .describe('ISO 3166-1 alpha-2 country code. Absent when unknown.'),
    region: z
      .string()
      .max(GEO_FIELD_MAX_LENGTH)
      .optional()
      .describe('Region or state name. Absent when unknown.'),
    city: z
      .string()
      .max(GEO_FIELD_MAX_LENGTH)
      .optional()
      .describe('City name. Absent when unknown.'),
    latitude: z.number().optional().describe('Latitude in decimal degrees. Absent when unknown.'),
    longitude: z.number().optional().describe('Longitude in decimal degrees. Absent when unknown.'),
    asn: z
      .string()
      .max(GEO_FIELD_MAX_LENGTH)
      .optional()
      .describe('Autonomous System number, e.g. "AS15169". Absent on providers that omit it.'),
    org: z
      .string()
      .max(GEO_FIELD_MAX_LENGTH)
      .optional()
      .describe('Owning organization or ISP, e.g. "Google LLC". Absent when unknown.'),
    timezone: z
      .string()
      .max(GEO_FIELD_MAX_LENGTH)
      .optional()
      .describe('IANA timezone, e.g. "America/Los_Angeles". Absent when unknown.'),
    proxy: z
      .boolean()
      .optional()
      .describe(
        'True when the address is a known proxy, VPN, or Tor exit — the location describes the exit node, not the user. Absent when the provider does not report it.',
      ),
    hosting: z
      .boolean()
      .optional()
      .describe(
        'True when the address belongs to a hosting or datacenter network, so the location is a facility rather than a person. Absent when unreported.',
      ),
    mobile: z
      .boolean()
      .optional()
      .describe(
        'True when the address belongs to a mobile carrier network, where NAT can place the location far from the device. Absent when unreported.',
      ),
    source: z.string().describe('The provider that answered the lookup, e.g. "ip-api".'),
  }),

  errors: [
    {
      reason: 'unresolvable_host',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A hostname target failed DNS resolution.',
      recovery: "Hostname didn't resolve. Verify it, or pass an IP address directly.",
      // GeoService.resolveTarget raises it; the handler never names the reason.
      thrownBy: 'service',
    },
    {
      reason: 'private_target',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The target resolves to a private/reserved IP with no public geolocation.',
      recovery: 'Private/reserved addresses have no public geolocation. Pass a public IP address.',
      // GeoService.lookup raises it — both at the private-range guard and on a
      // provider "fail" status for an unlocatable address.
      thrownBy: 'service',
    },
  ],

  handler(input, ctx) {
    // Service throws validationError carrying data.reason; it bubbles unchanged
    // and the auto-classifier preserves the reason for the declared contract.
    return getGeoService().lookup(input.target, ctx);
  },

  format: (result) => {
    const unknown = '_unknown_';
    const place =
      [result.city, result.region, result.country].filter(Boolean).join(', ') || unknown;
    const coords =
      result.latitude != null && result.longitude != null
        ? `${result.latitude}, ${result.longitude}`
        : unknown;
    const lines = [
      `**${result.target}** → ${result.resolvedIp}`,
      `**Location:** ${place}`,
      `**Coordinates:** ${coords}`,
      `**Timezone:** ${result.timezone ?? unknown}`,
      `**ASN:** ${result.asn ?? unknown} | **Org:** ${result.org ?? unknown}`,
      `**Country code:** ${result.countryCode ?? unknown}`,
      `**Proxy/VPN:** ${result.proxy ?? unknown} | **Hosting:** ${result.hosting ?? unknown} | **Mobile:** ${result.mobile ?? unknown}`,
      `**Source:** ${result.source}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
