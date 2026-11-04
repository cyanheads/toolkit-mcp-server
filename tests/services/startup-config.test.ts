/**
 * @fileoverview Server startup from the entry module: configuration failures pass
 * through the framework configuration banner, a clean start serves the session
 * instructions and the published skill tree, and the two gate flags decide
 * which tools tools/list carries (fail-closed: both gated tools absent unless
 * enabled).
 * @module tests/services/startup-config.test
 */
import { execFile, spawn } from 'node:child_process';
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
 * and returns a JSON-RPC client bound to it. A pending request rejects,
 * carrying stderr, if the process exits first.
 */
function startStdioServer(env: Record<string, string> = {}) {
  const child = spawn('bun', [entry], {
    env: { ...process.env, MCP_TRANSPORT_TYPE: 'stdio', DEBUG: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const waiting = new Map<
    number,
    { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }
  >();
  child.once('exit', (code) => {
    for (const { reject } of waiting.values())
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
