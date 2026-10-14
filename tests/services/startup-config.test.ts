/**
 * @fileoverview Startup failures pass through the framework configuration banner.
 * @module tests/services/startup-config.test
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const entry = new URL('../../src/index.ts', import.meta.url).pathname;

it.each([
  'TOOLKIT_GEO_CACHE_TTL_SECONDS',
  'TOOLKIT_ENABLE_SYSTEM_INFO',
  'TOOLKIT_GEO_BATCH_RATE_LIMIT_PER_MIN',
])('reports invalid %s through the configuration banner without a raw stack', async (name) => {
  const error = await run('bun', [entry], {
    env: { ...process.env, MCP_TRANSPORT_TYPE: 'stdio', DEBUG: '', [name]: 'invalid' },
    timeout: 10_000,
  }).catch((value: unknown) => value);
  expect(error).toMatchObject({ code: 1, stderr: expect.stringContaining(name) });
  const stderr = (error as { stderr: string }).stderr;
  expect(stderr).toMatch(/configuration error/i);
  expect(stderr).not.toMatch(/\n\s+at |\n\s+\^/);
});

it('retains a configuration stack only when DEBUG is enabled', async () => {
  const error = await run('bun', [entry], {
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: 'stdio',
      DEBUG: 'true',
      TOOLKIT_GEO_CACHE_TTL_SECONDS: 'invalid',
    },
    timeout: 10_000,
  }).catch((value: unknown) => value);
  expect(error).toMatchObject({ code: 1, stderr: expect.stringContaining('Configuration error') });
  expect((error as { stderr: string }).stderr).toMatch(/\n\s+at /);
});
