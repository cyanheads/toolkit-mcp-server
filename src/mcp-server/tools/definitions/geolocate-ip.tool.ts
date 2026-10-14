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

const GeoResultSchema = z
  .object({
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
  })
  .describe('Normalized geolocation metadata for one target.');

const BatchFailureSchema = z
  .object({
    target: z.string().describe('The failed target as supplied.'),
    error: z
      .object({
        reason: z
          .enum(['unresolvable_host', 'private_target', 'rate_limited', 'provider_unavailable'])
          .describe('Why this target could not be located.'),
        message: z.string().describe('Server-authored failure message.'),
        waitTimeSeconds: z
          .number()
          .optional()
          .describe('Seconds to wait before retrying a rate-limited target.'),
        recovery: z
          .object({ hint: z.string().describe('How to recover this target lookup.') })
          .describe('Recovery guidance for the failed target.'),
      })
      .describe('Failure for this input position.'),
  })
  .describe('A failed batch target with recovery guidance.');

/** Geolocate one public target or an ordered batch without contacting the targets. */
export const geolocateIpTool = tool('toolkit_geolocate_ip', {
  title: 'toolkit-mcp-server: geolocate IP',
  description:
    'Resolve a public IP or dotted hostname to country, region, city, coordinates, ASN, organization, timezone, and proxy/hosting/mobile flags. Supply target for one lookup or targets for an ordered batch, never both; blank target and empty targets are unset. Batches process the first 100 positions (duplicates retained) and disclose every remainder in unprocessedTargets; at most 1000 inputs are accepted. Each batch position reports its result or an error with recovery, so cached and local outcomes survive quota refusals. The provider is called directly, never the target. Hostnames are DNS-resolved and resolvedIp names the located address. Private/reserved addresses have no public geolocation. Results are best-effort, city-level at best; VPNs, proxies, mobile NAT, and anycast defeat IP-to-location. Read proxy, hosting, and mobile before trusting coordinates: true describes infrastructure, not the user. Absent metadata remains unknown. source names the provider. Single and batch quotas are independent; cache hits consume neither quota.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z
    .object({
      target: z
        .union([
          z.string().regex(/^\s*$/).describe('Blank means unset.'),
          ...NetworkTargetSchema.options,
        ])
        .optional()
        .describe('One public IP or dotted hostname; mutually exclusive with nonempty targets.'),
      targets: z
        .array(NetworkTargetSchema)
        .max(1000)
        .optional()
        .describe(
          'Ordered public IPs or dotted hostnames; first 100 positions are served, every remainder is disclosed. Mutually exclusive with nonblank target.',
        ),
    })
    .refine((input) => Boolean(input.target?.trim()) !== Boolean(input.targets?.length), {
      message: 'Supply exactly one nonblank target or nonempty targets array.',
    }),
  inputAliases: { ip: 'target', hostname: 'target', host: 'target' },
  output: GeoResultSchema.partial()
    .extend({
      results: z
        .array(
          z
            .union([GeoResultSchema, BatchFailureSchema])
            .describe('Result or failure for one input position.'),
        )
        .optional()
        .describe('Ordered results or failures for the first 100 input positions.'),
      failedCount: z.number().int().optional().describe('Number of failed processed targets.'),
      unprocessedTargets: z
        .array(z.string().describe('One unprocessed target.'))
        .optional()
        .describe(
          'Every input position past the first 100; resubmit these targets in another batch.',
        ),
    })
    .refine(
      (result) =>
        result.results !== undefined
          ? result.failedCount !== undefined && result.unprocessedTargets !== undefined
          : result.target !== undefined &&
            result.resolvedIp !== undefined &&
            result.source !== undefined,
      { message: 'Expected a complete scalar or batch result.' },
    ),

  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The endpoint request quota or provider cooldown is exhausted.',
      recovery: 'Wait the reported number of seconds before retrying, or reuse a cached result.',
      retryable: true,
      thrownBy: 'service',
    },
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
    return input.targets?.length
      ? getGeoService().lookupBatch(input.targets, ctx)
      : getGeoService().lookup(input.target as string, ctx);
  },

  format: (result) => {
    const sections: string[] = [];
    if (
      result.target !== undefined &&
      result.resolvedIp !== undefined &&
      result.source !== undefined
    )
      sections.push(
        formatGeo({
          ...result,
          target: result.target,
          resolvedIp: result.resolvedIp,
          source: result.source,
        }),
      );
    if (result.results) {
      const text = result.results
        .map((entry) =>
          'error' in entry
            ? `**${entry.target}**: ${entry.error.reason} — ${entry.error.message}\nRecovery: ${entry.error.recovery.hint}${entry.error.waitTimeSeconds === undefined ? '' : `\nWait: ${entry.error.waitTimeSeconds} seconds`}`
            : formatGeo(entry),
        )
        .join('\n\n');
      sections.push(
        `${text}\n\nFailed: ${result.failedCount}\nUnprocessed targets (resubmit): ${JSON.stringify(result.unprocessedTargets)}`,
      );
    }
    return [{ type: 'text', text: sections.join('\n\n') }];
  },
});

function formatGeo(result: z.infer<typeof GeoResultSchema>): string {
  const unknown = '_unknown_';
  const place = [result.city, result.region, result.country].filter(Boolean).join(', ') || unknown;
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
  return lines.join('\n');
}
