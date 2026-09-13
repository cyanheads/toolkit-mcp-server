/**
 * @fileoverview Exercises plugin-supplied values at the server configuration boundary.
 * @module tests/services/server-config.test
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerConfig();
});

describe('server environment configuration', () => {
  it.each(['', `\${user_config.unset}`])('treats %j as unset for plugin options', (value) => {
    for (const key of [
      'TOOLKIT_ENABLE_NET_DIAGNOSTICS',
      'TOOLKIT_ENABLE_SYSTEM_INFO',
      'TOOLKIT_ALLOW_PRIVATE_NETWORK',
      'TOOLKIT_GEO_API_KEY',
      'TOOLKIT_GEO_BASE_URL',
      'TOOLKIT_GEO_CACHE_TTL_SECONDS',
      'TOOLKIT_GEO_RATE_LIMIT_PER_MIN',
    ]) {
      vi.stubEnv(key, value);
    }
    expect(getServerConfig()).toEqual({
      enableNetDiagnostics: false,
      enableSystemInfo: false,
      allowPrivateNetwork: false,
      geoApiKey: undefined,
      geoBaseUrl: 'http://ip-api.com',
      geoCacheTtlSeconds: 3600,
      geoRateLimitPerMin: 45,
    });
  });

  it('preserves explicit false, zero TTL, and embedded placeholder text', () => {
    vi.stubEnv('TOOLKIT_ENABLE_NET_DIAGNOSTICS', 'false');
    vi.stubEnv('TOOLKIT_GEO_CACHE_TTL_SECONDS', '0');
    vi.stubEnv('TOOLKIT_GEO_API_KEY', `prefix-\${literal}-suffix`);
    expect(getServerConfig()).toMatchObject({
      enableNetDiagnostics: false,
      geoCacheTtlSeconds: 0,
      geoApiKey: `prefix-\${literal}-suffix`,
    });
  });
});
