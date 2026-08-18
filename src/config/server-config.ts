/**
 * @fileoverview Server-specific configuration for toolkit-mcp-server.
 * Holds the security gate flags (fail-closed) and geolocation endpoint settings.
 * Lazy-parsed via `parseEnvConfig` so env-var names appear in validation errors
 * and Workers can inject env at request time.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Server config schema. Booleans use `z.stringbool()` so `=false` actually
 * disables (unlike `z.coerce.boolean()`, where `Boolean("false") === true`).
 */
const ServerConfigSchema = z.object({
  /** Registers `toolkit_check_network`. Off → the tool is absent from tools/list. */
  enableNetDiagnostics: z
    .stringbool()
    .default(false)
    .describe('Enable the gated toolkit_check_network tool. Off by default (fail-closed).'),
  /** Registers `toolkit_check_system`. Off → the tool is absent from tools/list. */
  enableSystemInfo: z
    .stringbool()
    .default(false)
    .describe('Enable the gated toolkit_check_system tool. Off by default (fail-closed).'),
  /**
   * Second-tier gate: with net-diag on, permits private/reserved/loopback/
   * link-local targets. Off → such targets are rejected at request time.
   */
  allowPrivateNetwork: z
    .stringbool()
    .default(false)
    .describe(
      'Permit private/reserved/loopback/link-local network targets in toolkit_check_network. The second explicit gate for local-network diagnostics.',
    ),
  /** Optional API key for the geolocation endpoint. */
  geoApiKey: z
    .string()
    .optional()
    .describe('API key for the geolocation endpoint, if it requires one.'),
  /** Base URL override for an ip-api-compatible endpoint (e.g. an ip-api pro endpoint). */
  geoBaseUrl: z
    .string()
    .url()
    .default('http://ip-api.com')
    .describe(
      'Base URL for an ip-api-compatible geolocation endpoint. Default is the keyless plaintext-HTTP ip-api endpoint.',
    ),
  /** GeoService in-memory cache TTL, in seconds. */
  geoCacheTtlSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .default(3600)
    .describe('GeoService cache TTL in seconds. Geolocation is stable, so repeats are cached.'),
  /** Max geo-API requests per minute; excess is rejected with a retryable rate-limit error. Default matches ip-api free tier. */
  geoRateLimitPerMin: z.coerce
    .number()
    .int()
    .min(1)
    .default(45)
    .describe(
      'Max geolocation requests per minute; excess requests are rejected with a retryable rate-limit error. Default 45 matches the ip-api free tier.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazily parse and memoize the server config from the environment. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    enableNetDiagnostics: 'TOOLKIT_ENABLE_NET_DIAGNOSTICS',
    enableSystemInfo: 'TOOLKIT_ENABLE_SYSTEM_INFO',
    allowPrivateNetwork: 'TOOLKIT_ALLOW_PRIVATE_NETWORK',
    geoApiKey: 'TOOLKIT_GEO_API_KEY',
    geoBaseUrl: 'TOOLKIT_GEO_BASE_URL',
    geoCacheTtlSeconds: 'TOOLKIT_GEO_CACHE_TTL_SECONDS',
    geoRateLimitPerMin: 'TOOLKIT_GEO_RATE_LIMIT_PER_MIN',
  });
  return _config;
}

/** Reset the memoized config — test-only, to re-parse after mutating env vars. */
export function resetServerConfig(): void {
  _config = undefined;
}
