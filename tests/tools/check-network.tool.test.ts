/**
 * @fileoverview Tests for toolkit_check_network at the TOOL layer — error
 * contracts and validation at the handler boundary, plus the diagnostic-gate
 * behavior surfaced through the tool, and the new result fields on both client
 * surfaces (structuredContent and content[]). No live ping/traceroute/DNS: the
 * private-range gate and the required-field validators all fire BEFORE any probe
 * runs, `node:child_process` is mocked for ping, and public_ip is exercised with
 * a stubbed `fetch`. The live touches are loopback TCP probes (gate-on path) —
 * one to a closed port (refused) and one to an ephemeral listener (open) —
 * which never leave the host.
 * @module tests/tools/check-network.tool.test
 */

import { type AddressInfo, createServer } from 'node:net';
import process from 'node:process';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { checkNetworkTool } from '@/mcp-server/tools/definitions/check-network.tool.js';
import { initNetDiagService } from '@/services/network/net-diag-service.js';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

const ORIGINAL_PLATFORM = process.platform;
const setPlatform = (value: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value, configurable: true });

/** macOS 27 ping against TEST-NET-2, captured verbatim: a real no-reply. */
const PING_MACOS_NO_REPLY = `PING 198.51.100.1 (198.51.100.1): 56 data bytes
Request timeout for icmp_seq 0

--- 198.51.100.1 ping statistics ---
2 packets transmitted, 0 packets received, 100.0% packet loss
`;

const run = (args: unknown) =>
  checkNetworkTool.handler(
    checkNetworkTool.input.parse(args),
    createMockContext({ errors: checkNetworkTool.errors }),
  );

/** A TCP listener on an ephemeral loopback port, closed when the scope exits. */
const listenOnLoopback = async () => {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    [Symbol.asyncDispose]: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe('toolkit_check_network — gate + validation', () => {
  beforeEach(() => {
    resetServerConfig();
    initNetDiagService();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetServerConfig();
  });

  it('blocks the cloud-metadata endpoint when ALLOW_PRIVATE_NETWORK is off', async () => {
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'false');
    resetServerConfig();
    initNetDiagService();
    await expect(
      run({ mode: 'connectivity', target: '169.254.169.254', port: 80 }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'private_target_blocked' },
    });
  });

  it('blocks an RFC-1918 target for ping when the gate is off', async () => {
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'false');
    resetServerConfig();
    initNetDiagService();
    await expect(run({ mode: 'ping', target: '10.0.0.1' })).rejects.toMatchObject({
      data: { reason: 'private_target_blocked' },
    });
  });

  it('blocks a TEST-NET (IANA documentation) target when the gate is off', async () => {
    // TEST-NET-3 (203.0.113.0/24) classifies as reserved, so the gate rejects it
    // like any other private/reserved target when ALLOW_PRIVATE_NETWORK is off.
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'false');
    resetServerConfig();
    initNetDiagService();
    await expect(run({ mode: 'ping', target: '203.0.113.7' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'private_target_blocked' },
    });
  });

  it('rejects a missing target for a target-bearing mode (before any probe)', async () => {
    await expect(run({ mode: 'ping' })).rejects.toThrow(/target is required/);
  });

  it('rejects connectivity without a port (before opening a socket)', async () => {
    // Gate-on so a raw IP passes guardTarget synchronously (no DNS) — 203.0.113.7
    // is now TEST-NET reserved but ALLOW_PRIVATE_NETWORK permits it — then
    // connectivity() throws on the missing port before any connect() is attempted.
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'true');
    resetServerConfig();
    initNetDiagService();
    await expect(run({ mode: 'connectivity', target: '203.0.113.7' })).rejects.toThrow(
      /port is required/,
    );
  });

  it('permits a private loopback target through the gate when ALLOW_PRIVATE_NETWORK is on', async () => {
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'true');
    resetServerConfig();
    initNetDiagService();
    // Gate permits it; a TCP probe to a closed loopback port resolves
    // reachable:false (a valid down result), NOT the gate error — and the
    // outcome says the host answered with nothing listening.
    const result = await run({ mode: 'connectivity', target: '127.0.0.1', port: 1 });
    expect(result).toEqual({
      mode: 'connectivity',
      target: '127.0.0.1',
      reachable: false,
      outcome: 'refused',
    });
  });

  it('reports a listening loopback port as reachable, open, with the connect time', async () => {
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'true');
    resetServerConfig();
    initNetDiagService();
    await using listener = await listenOnLoopback();
    const result = await run({ mode: 'connectivity', target: '127.0.0.1', port: listener.port });
    expect(result).toMatchObject({
      mode: 'connectivity',
      target: '127.0.0.1',
      reachable: true,
      outcome: 'open',
      rttMs: expect.any(Number),
    });
  });

  it('returns the host egress IP for public_ip mode (stubbed upstream)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: async () => ({ ip: '203.0.113.99' }),
        text: async () => '{"ip":"203.0.113.99"}',
      } as unknown as Response),
    );
    const result = await run({ mode: 'public_ip' });
    expect(result).toMatchObject({ mode: 'public_ip', publicIp: '203.0.113.99' });
  });

  it('rejects an invalid target at the schema boundary', () => {
    // host:port inline syntax is explicitly disallowed (port is a separate param).
    expect(
      checkNetworkTool.input.safeParse({ mode: 'connectivity', target: 'db:5432' }).success,
    ).toBe(false);
    expect(checkNetworkTool.input.safeParse({ mode: 'ping', target: 'localhost' }).success).toBe(
      false,
    );
  });

  it('enforces count and port bounds', () => {
    expect(
      checkNetworkTool.input.safeParse({ mode: 'ping', target: '8.8.8.8', count: 0 }).success,
    ).toBe(false);
    expect(
      checkNetworkTool.input.safeParse({ mode: 'ping', target: '8.8.8.8', count: 11 }).success,
    ).toBe(false);
    expect(
      checkNetworkTool.input.safeParse({
        mode: 'connectivity',
        target: '8.8.8.8',
        port: 70000,
      }).success,
    ).toBe(false);
  });
});

/** Every text block of a result, joined — the `content[]` surface a client reads. */
const contentText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

describe('toolkit_check_network — both client surfaces', () => {
  beforeEach(() => {
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'true');
    resetServerConfig();
    initNetDiagService();
    execFileMock.mockReset();
    setPlatform('darwin');
  });
  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it('carries ping packet loss in structuredContent and content[]', async () => {
    execFileMock.mockImplementation(
      (cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) =>
        cb(
          Object.assign(new Error(`Command failed: ${cmd}`), {
            code: 2,
            stdout: PING_MACOS_NO_REPLY,
            stderr: '',
          }),
        ),
    );
    const result = await runToolContract(checkNetworkTool, {
      mode: 'ping',
      target: '198.51.100.1',
      count: 2,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      mode: 'ping',
      target: '198.51.100.1',
      reachable: false,
      sent: 2,
      received: 0,
      packetLossPercent: 100,
    });
    const text = contentText(result);
    expect(text).toContain('NOT reachable');
    expect(text).toContain('2 sent, 0 received, 100% loss');
  });

  it('carries a missing ping binary as a typed unreachable error on both surfaces', async () => {
    execFileMock.mockImplementation(
      (cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) =>
        cb(
          Object.assign(new Error(`spawn ${cmd} ENOENT`), {
            code: 'ENOENT',
            stdout: '',
            stderr: '',
          }),
        ),
    );
    const result = await runToolContract(checkNetworkTool, { mode: 'ping', target: '1.1.1.1' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(/^ping could not be started \(ENOENT\)/),
        data: { reason: 'unreachable', recovery: { hint: expect.any(String) } },
      },
    });
    const text = contentText(result);
    expect(text).toContain('ping could not be started (ENOENT)');
    expect(text).toContain('diagnostic binary is available');
    expect(text).not.toContain('reachable: false');
  });

  it('carries the connect outcome and time in structuredContent and content[]', async () => {
    await using listener = await listenOnLoopback();
    const result = await runToolContract(checkNetworkTool, {
      mode: 'connectivity',
      target: '127.0.0.1',
      port: listener.port,
    });
    expect(result.structuredContent).toMatchObject({
      reachable: true,
      outcome: 'open',
      rttMs: expect.any(Number),
    });
    const { rttMs } = result.structuredContent as { rttMs: number };
    expect(contentText(result)).toContain(`reachable (open) — connect ${rttMs} ms`);
  });

  it.each([
    [{ mode: 'traceroute' }, 'missing_target', /target is required/],
    [{ mode: 'connectivity', target: '127.0.0.1' }, 'missing_port', /port is required/],
  ] as const)(
    'rejects %o with %s and its recovery on both surfaces',
    async (input, reason, message) => {
      const result = await runToolContract(checkNetworkTool, input);
      expect(result.isError).toBe(true);
      const recovery = checkNetworkTool.errors!.find((e) => e.reason === reason)!.recovery;
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringMatching(message),
          data: { reason, recovery: { hint: recovery } },
        },
      });
      const text = contentText(result);
      expect(text).toMatch(message);
      expect(text).toContain(recovery as string);
    },
  );
});

describe('toolkit_check_network format()', () => {
  it('renders the connect outcome for a refused port', () => {
    const blocks = checkNetworkTool.format!({
      mode: 'connectivity',
      target: '192.0.2.10',
      reachable: false,
      outcome: 'refused',
    });
    expect((blocks[0] as { text: string }).text).toContain('192.0.2.10:** NOT reachable (refused)');
  });

  it('renders ping packet counts alongside the average RTT', () => {
    const text = (
      checkNetworkTool.format!({
        mode: 'ping',
        target: '1.1.1.1',
        reachable: true,
        rttMs: 21.5,
        sent: 3,
        received: 2,
        packetLossPercent: 33.3,
      })[0] as { text: string }
    ).text;
    expect(text).toContain('reachable — avg 21.5 ms');
    expect(text).toContain('3 sent, 2 received, 33.3% loss');
  });

  it('renders ping reachability and RTT', () => {
    const blocks = checkNetworkTool.format!({
      mode: 'ping',
      target: '8.8.8.8',
      reachable: true,
      rttMs: 12.5,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('ping');
    expect(text).toContain('8.8.8.8');
    expect(text).toContain('reachable');
    expect(text).toContain('12.5');
  });

  it('renders an unreachable host distinctly', () => {
    const blocks = checkNetworkTool.format!({
      mode: 'connectivity',
      target: '8.8.8.8',
      reachable: false,
    });
    expect((blocks[0] as { text: string }).text).toContain('NOT reachable');
  });

  it('renders the traceroute hop path', () => {
    const blocks = checkNetworkTool.format!({
      mode: 'traceroute',
      target: '8.8.8.8',
      hops: [
        { hop: 1, address: '192.0.2.1', rttMs: 1.2 },
        { hop: 2, address: '*' },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2 hops');
    expect(text).toContain('192.0.2.1');
    expect(text).toContain('*');
  });

  it('renders the public egress IP', () => {
    const blocks = checkNetworkTool.format!({ mode: 'public_ip', publicIp: '203.0.113.99' });
    expect((blocks[0] as { text: string }).text).toContain('203.0.113.99');
  });
});
