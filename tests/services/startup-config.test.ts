/**
 * @fileoverview Server startup from the entry module: configuration failures pass
 * through the framework configuration banner, a clean start serves the session
 * instructions and the published skill tree, the two gate flags decide which
 * tools tools/list carries (fail-closed: both gated tools absent unless
 * enabled), and the opt-in failure-payload log redacts `secret`.
 * @module tests/services/startup-config.test
 */
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const entry = new URL('../../src/index.ts', import.meta.url).pathname;
const skillFile = new URL('../../skills/toolkit-guide/SKILL.md', import.meta.url).pathname;
const SKILL_URI = 'skill://toolkit-guide/SKILL.md';

type RpcResponse = { id: number; result?: Record<string, unknown>; error?: unknown };

/**
 * Spawns the server over stdio, with `env` laid over the inherited environment,
 * and returns a JSON-RPC client bound to it plus the stderr it has written. A
 * pending request or stderr wait rejects, carrying stderr, if the process exits
 * first.
 */
function startStdioServer(env: Record<string, string> = {}) {
  const child = spawn('bun', [entry], {
    env: { ...process.env, MCP_TRANSPORT_TYPE: 'stdio', DEBUG: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  /** Re-checked on every stderr chunk until each finds its line. */
  const stderrWaits = new Set<{ check: () => void; reject: (e: Error) => void }>();
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    for (const wait of stderrWaits) wait.check();
  });
  const waiting = new Map<
    number,
    { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }
  >();
  child.once('exit', (code) => {
    for (const { reject } of [...waiting.values(), ...stderrWaits])
      reject(new Error(`server exited (${code}): ${stderr}`));
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as RpcResponse;
    waiting.get(message.id)?.resolve(message);
  });
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  return {
    child,
    /** Everything the process has written to stderr so far. */
    stderr: () => stderr,
    /**
     * The first complete stderr line `match` accepts, checked as each chunk
     * arrives. Rejects after `timeoutMs`, or if the process exits first.
     */
    waitForStderrLine: (match: (line: string) => boolean, timeoutMs: number) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          stderrWaits.delete(wait);
          reject(new Error(`no matching stderr line within ${timeoutMs} ms: ${stderr}`));
        }, timeoutMs);
        const wait = {
          check: () => {
            // The text after the last newline may be a line still being written.
            const line = stderr.split('\n').slice(0, -1).find(match);
            if (line === undefined) return;
            clearTimeout(timer);
            stderrWaits.delete(wait);
            resolve(line);
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        stderrWaits.add(wait);
        wait.check();
      }),
    notify: (method: string) => send({ method }),
    request: (id: number, method: string, params: Record<string, unknown> = {}) =>
      new Promise<RpcResponse>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        send({ id, method, params });
      }),
  };
}

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

it('serves the session instructions and the toolkit-guide skill on a clean start', async () => {
  const server = startStdioServer();
  try {
    const init = await server.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'startup-config-test', version: '0.0.0' },
    });
    server.notify('notifications/initialized');
    const list = await server.request(2, 'resources/list');
    const read = await server.request(3, 'resources/read', { uri: SKILL_URI });

    expect(init.result?.instructions).toEqual(expect.stringContaining(SKILL_URI));
    expect(list.result?.resources).toContainEqual(expect.objectContaining({ uri: SKILL_URI }));
    expect(read.result?.contents).toEqual([
      expect.objectContaining({ uri: SKILL_URI, text: readFileSync(skillFile, 'utf8') }),
    ]);
  } finally {
    server.child.kill();
  }
}, 20_000);

const ALWAYS_ON = [
  'toolkit_encode_value',
  'toolkit_generate_id',
  'toolkit_generate_qr',
  'toolkit_geolocate_ip',
  'toolkit_hash_value',
];

it.each([
  {
    state: 'off',
    flag: 'false',
    expected: ALWAYS_ON,
  },
  {
    state: 'on',
    flag: 'true',
    expected: [...ALWAYS_ON, 'toolkit_check_network', 'toolkit_check_system'].sort(),
  },
])(
  'lists exactly the tools the gate flags allow, and instructions name each, with the flags $state',
  async ({ flag, expected }) => {
    const server = startStdioServer({
      TOOLKIT_ENABLE_NET_DIAGNOSTICS: flag,
      TOOLKIT_ENABLE_SYSTEM_INFO: flag,
    });
    try {
      const init = await server.request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'startup-config-test', version: '0.0.0' },
      });
      server.notify('notifications/initialized');
      const list = await server.request(2, 'tools/list');
      const { tools } = list.result as { tools: { name: string }[] };
      const names = tools.map(({ name }) => name).sort();

      expect(names).toEqual(expected);
      // Instructions describe both gated tools whatever the flags say, so every
      // listed name must appear in them; a renamed tool fails here.
      const instructions = init.result?.instructions as string;
      expect(names.filter((name) => !instructions.includes(name))).toEqual([]);
    } finally {
      server.child.kill();
    }
  },
  20_000,
);

const FAILURE_PAYLOAD_MSG = 'Tool failure payload: toolkit_hash_value';
/** A secret nothing else the server writes contains, so finding it on stderr is a leak. */
const PROBE_SECRET = 'zz-PROBE-secret-4c1d';

it('redacts secret from the failure-payload record of a failed toolkit_hash_value call', async () => {
  // The framework logger writes no stderr sink under the NODE_ENV=test the runner sets.
  const server = startStdioServer({ LOG_TOOL_FAILURE_PAYLOADS: 'true', NODE_ENV: 'production' });
  try {
    await server.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'startup-config-test', version: '0.0.0' },
    });
    server.notify('notifications/initialized');
    const call = await server.request(2, 'tools/call', {
      name: 'toolkit_hash_value',
      arguments: { value: 'hello', secret: PROBE_SECRET, expected: 'not a digest!' },
    });
    expect(call.result).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'expected_malformed' } } },
    });
    // The record is written before the response, but the log sink can flush it after.
    const line = await server.waitForStderrLine(
      (text) => text.includes(`"msg":"${FAILURE_PAYLOAD_MSG}"`),
      10_000,
    );
    const record = JSON.parse(line) as { msg: string; toolInput: string };
    expect(record.msg).toBe(FAILURE_PAYLOAD_MSG);
    expect(record.toolInput).toContain('"secret":"[REDACTED]"');
    expect(JSON.parse(record.toolInput)).toEqual({
      value: 'hello',
      secret: '[REDACTED]',
      expected: 'not a digest!',
    });
    // Every record the process writes, up to its exit, keeps the value out.
    server.child.kill();
    await once(server.child, 'close');
    expect(server.stderr()).toContain(FAILURE_PAYLOAD_MSG);
    expect(server.stderr()).not.toContain(PROBE_SECRET);
    expect(JSON.stringify(call)).not.toContain(PROBE_SECRET);
  } finally {
    server.child.kill();
  }
}, 20_000);
