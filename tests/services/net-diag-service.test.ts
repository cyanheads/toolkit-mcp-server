/**
 * @fileoverview Tests for NetDiagService's probe internals — the OS-binary
 * command lines per platform, the ping/traceroute output parsers, the declared
 * `unreachable` failures and their recovery metadata, and the sanitized
 * egress-IP provider failure. `node:child_process` and `node:dns/promises` are
 * mocked so no probe, DNS query, or packet leaves the host; `fetch` is stubbed
 * for the egress-IP echo. The private-range gate itself is covered by
 * net-diag-gate.test.ts.
 * @module tests/services/net-diag-service.test
 */

import process from 'node:process';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { checkNetworkTool } from '@/mcp-server/tools/definitions/check-network.tool.js';
import { getNetDiagService, initNetDiagService } from '@/services/network/net-diag-service.js';

const { execFileMock, lookupMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  lookupMock: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

/** The contract entry under test — asserted against, never re-typed inline. */
const UNREACHABLE_RECOVERY = checkNetworkTool.errors!.find((e) => e.reason === 'unreachable')!
  .recovery as string;

/** Promisified execFile resolves `{ stdout, stderr }`; the mock answers in kind. */
const spawnSucceeds = (stdout: string) =>
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void,
    ) => cb(null, { stdout, stderr: '' }),
  );

const spawnFails = (message: string) =>
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) =>
      cb(new Error(message)),
  );

/** The argv the service actually spawned: `[command, args]`. */
const spawnedWith = (): [string, string[]] => {
  const call = execFileMock.mock.calls[0] as [string, string[], unknown, unknown];
  return [call[0], call[1]];
};

const ORIGINAL_PLATFORM = process.platform;
const setPlatform = (value: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value, configurable: true });

const run = (input: Parameters<ReturnType<typeof getNetDiagService>['run']>[0]) =>
  getNetDiagService().run(input, createMockContext({ errors: checkNetworkTool.errors }));

const PING_BSD = `PING 8.8.8.8 (8.8.8.8): 56 data bytes
64 bytes from 8.8.8.8: icmp_seq=0 ttl=118 time=11.234 ms

--- 8.8.8.8 ping statistics ---
3 packets transmitted, 3 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 10.100/11.234/12.500/0.900 ms
`;

const PING_WINDOWS = `
Pinging 8.8.8.8 with 32 bytes of data:
Reply from 8.8.8.8: bytes=32 time=10ms TTL=118
Reply from 8.8.8.8: bytes=32 time=12ms TTL=118
Reply from 8.8.8.8: bytes=32 time=11ms TTL=118

Ping statistics for 8.8.8.8:
    Packets: Sent = 3, Received = 3, Lost = 0 (0% loss),
Approximate round trip times in milli-seconds:
    Minimum = 10ms, Maximum = 12ms, Average = 11ms
`;

const TRACEROUTE_UNIX = `traceroute to 8.8.8.8 (8.8.8.8), 30 hops max, 60 byte packets
 1  192.168.1.1  1.234 ms
 2  *
 3  8.8.8.8  11.500 ms
`;

const TRACERT_WINDOWS = `
Tracing route to 8.8.8.8 over a maximum of 30 hops

  1     1 ms     1 ms     1 ms  192.168.1.1
  2     *        *        *     Request timed out.
  3    11 ms    12 ms    10 ms  8.8.8.8

Trace complete.
`;

/** Response-like object for the stubbed egress-IP echo. */
const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

describe('NetDiagService probes', () => {
  beforeEach(() => {
    resetServerConfig();
    initNetDiagService();
    execFileMock.mockReset();
    lookupMock.mockReset();
  });

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetServerConfig();
  });

  describe('ping — platform command lines', () => {
    it('spawns the BSD flag set on darwin (-c count, -t deadline in seconds)', async () => {
      setPlatform('darwin');
      spawnSucceeds(PING_BSD);
      const result = await run({ mode: 'ping', target: '8.8.8.8', count: 3, timeoutMs: 3000 });
      expect(spawnedWith()).toEqual(['ping', ['-c', '3', '-t', '9', '8.8.8.8']]);
      expect(result).toMatchObject({ mode: 'ping', reachable: true, rttMs: 11.234 });
    });

    it('spawns the Linux flag set on linux (-c count, -w deadline in seconds)', async () => {
      setPlatform('linux');
      spawnSucceeds(PING_BSD);
      await run({ mode: 'ping', target: '8.8.8.8', count: 3, timeoutMs: 3000 });
      expect(spawnedWith()).toEqual(['ping', ['-c', '3', '-w', '9', '8.8.8.8']]);
    });

    it('spawns the Windows flag set on win32 (-n count, -w per-reply timeout in ms)', async () => {
      setPlatform('win32');
      spawnSucceeds(PING_WINDOWS);
      const result = await run({ mode: 'ping', target: '8.8.8.8', count: 3, timeoutMs: 3000 });
      expect(spawnedWith()).toEqual(['ping', ['-n', '3', '-w', '3000', '8.8.8.8']]);
      // A responding host is reachable — not the silent false negative Windows
      // produced when it was handed the BSD `-c` flag.
      expect(result).toMatchObject({ mode: 'ping', target: '8.8.8.8', reachable: true });
    });

    it('reads the average RTT from Windows ping statistics, not the first reply', async () => {
      setPlatform('win32');
      spawnSucceeds(PING_WINDOWS);
      // Replies are 10/12/11 ms; the summary average is 11 ms. Taking the first
      // reply would report 10.
      const result = await run({ mode: 'ping', target: '8.8.8.8', count: 3, timeoutMs: 3000 });
      expect(result).toMatchObject({ rttMs: 11 });
    });

    it('reports a non-responding host as reachable:false, not an error', async () => {
      setPlatform('darwin');
      spawnFails('Command failed: ping -c 3 -t 9 8.8.8.8');
      const result = await run({ mode: 'ping', target: '8.8.8.8', count: 3, timeoutMs: 3000 });
      expect(result).toEqual({ mode: 'ping', target: '8.8.8.8', reachable: false });
    });
  });

  describe('traceroute — platform command lines and parsing', () => {
    it('parses unix traceroute output, including a silent hop', async () => {
      setPlatform('darwin');
      spawnSucceeds(TRACEROUTE_UNIX);
      const result = await run({
        mode: 'traceroute',
        target: '8.8.8.8',
        count: 3,
        timeoutMs: 3000,
      });
      expect(spawnedWith()[0]).toBe('traceroute');
      expect(result).toEqual({
        mode: 'traceroute',
        target: '8.8.8.8',
        hops: [
          { hop: 1, address: '192.168.1.1', rttMs: 1.234 },
          { hop: 2, address: '*' },
          { hop: 3, address: '8.8.8.8', rttMs: 11.5 },
        ],
      });
    });

    it('parses an IPv6 hop address', async () => {
      setPlatform('darwin');
      spawnSucceeds(' 1  2001:4860:4860::8888  1.100 ms\n');
      const result = await run({
        mode: 'traceroute',
        target: '8.8.8.8',
        count: 3,
        timeoutMs: 3000,
      });
      expect(result).toMatchObject({
        hops: [{ hop: 1, address: '2001:4860:4860::8888', rttMs: 1.1 }],
      });
    });

    it('shells out to tracert with the Windows flag set on win32', async () => {
      setPlatform('win32');
      spawnSucceeds(TRACERT_WINDOWS);
      await run({ mode: 'traceroute', target: '8.8.8.8', count: 3, timeoutMs: 3000 });
      const [cmd, args] = spawnedWith();
      expect(cmd).toBe('tracert');
      expect(args).toContain('-d'); // numeric — no reverse DNS
      expect(args).toContain('8.8.8.8');
    });

    it('parses tracert output, reading the address after the RTT columns', async () => {
      setPlatform('win32');
      spawnSucceeds(TRACERT_WINDOWS);
      const result = await run({
        mode: 'traceroute',
        target: '8.8.8.8',
        count: 3,
        timeoutMs: 3000,
      });
      // "Request timed out." must read as a silent hop — never a fragment of the
      // message mistaken for an address.
      expect(result).toEqual({
        mode: 'traceroute',
        target: '8.8.8.8',
        hops: [
          { hop: 1, address: '192.168.1.1', rttMs: 1 },
          { hop: 2, address: '*' },
          { hop: 3, address: '8.8.8.8', rttMs: 11 },
        ],
      });
    });

    it('throws unreachable with the declared recovery when the binary fails', async () => {
      setPlatform('darwin');
      spawnFails('spawn traceroute ENOENT');
      const error = (await run({
        mode: 'traceroute',
        target: '8.8.8.8',
        count: 3,
        timeoutMs: 3000,
      }).catch((e: unknown) => e)) as { data?: Record<string, unknown>; cause?: unknown };
      expect(error.data).toMatchObject({
        reason: 'unreachable',
        recovery: { hint: UNREACHABLE_RECOVERY },
      });
      // The original failure stays server-side as `cause`.
      expect((error as { cause?: Error }).cause).toBeInstanceOf(Error);
    });
  });

  describe('hostname resolution failures', () => {
    it('throws unreachable with the declared recovery when a hostname will not resolve', async () => {
      lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND no-such-host.invalid'));
      const error = (await run({
        mode: 'connectivity',
        target: 'no-such-host.invalid',
        port: 443,
        count: 3,
        timeoutMs: 500,
      }).catch((e: unknown) => e)) as { message?: string; data?: Record<string, unknown> };
      expect(error.message).toMatch(/could not resolve/i);
      expect(error.data).toMatchObject({
        reason: 'unreachable',
        recovery: { hint: UNREACHABLE_RECOVERY },
      });
    });

    it('probes the resolved address when a hostname does resolve', async () => {
      setPlatform('darwin');
      lookupMock.mockResolvedValue({ address: '93.184.216.34', family: 4 });
      spawnSucceeds(PING_BSD);
      const result = await run({
        mode: 'ping',
        target: 'example.com',
        count: 1,
        timeoutMs: 1000,
      });
      expect(spawnedWith()[1]).toContain('93.184.216.34');
      // The echoed target stays the caller's hostname, not the resolved IP.
      expect(result).toMatchObject({ mode: 'ping', target: 'example.com' });
    });
  });

  describe('public_ip — egress-IP echo', () => {
    it('returns the echoed address', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ip: '203.0.113.99' })));
      const result = await run({ mode: 'public_ip', count: 3, timeoutMs: 3000 });
      expect(result).toEqual({ mode: 'public_ip', publicIp: '203.0.113.99' });
    });

    it('reports an echo response with no address', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})));
      await expect(run({ mode: 'public_ip', count: 3, timeoutMs: 3000 })).rejects.toThrow(
        /no address/i,
      );
    });

    it('sanitizes a non-OK upstream response — no provider internals reach the client', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse({ secret: 'upstream-body-should-not-leak' }, 503)),
      );
      const error = (await run({ mode: 'public_ip', count: 3, timeoutMs: 3000 }).catch(
        (e: unknown) => e,
      )) as { message?: string; data?: unknown };
      expect(error.message).toMatch(/egress-ip echo .* unavailable/i);
      expect(error.message).not.toMatch(/ipify|http|status|503|secret/i);
      const data = (error.data ?? {}) as Record<string, unknown>;
      expect(data).not.toHaveProperty('statusCode');
      expect(data).not.toHaveProperty('responseBody');
      expect(data).not.toHaveProperty('requestId');
      expect(JSON.stringify(data)).not.toMatch(/upstream-body-should-not-leak|ipify/);
    });

    it('sanitizes a transport failure the same way', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 1.2.3.4')));
      const error = (await run({ mode: 'public_ip', count: 3, timeoutMs: 3000 }).catch(
        (e: unknown) => e,
      )) as { message?: string };
      expect(error.message).toMatch(/egress-ip echo .* unavailable/i);
      expect(error.message).not.toMatch(/ECONNREFUSED|1\.2\.3\.4/);
    });

    it('keeps upstream echo detail out of the client-visible log sink', async () => {
      // `ctx.log` is dual-sink: every call also emits `notifications/message` to
      // the client, and an error call puts `error.message` on that payload. The
      // framework fetch error names the echo URL and HTTP status — the same
      // provenance the sanitizing re-throw above strips — so handing the raw
      // error to `ctx.log` would route it around the sanitizer.
      const failures: Array<[string, unknown]> = [
        ['non-OK', vi.fn().mockResolvedValue(jsonResponse({ secret: 'leaky-body' }, 503))],
        ['transport', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 1.2.3.4'))],
      ];
      for (const [, fetchImpl] of failures) {
        vi.stubGlobal('fetch', fetchImpl);
        const ctx = createMockContext({ errors: checkNetworkTool.errors });
        const errorSpy = vi.spyOn(ctx.log, 'error');
        await getNetDiagService()
          .run({ mode: 'public_ip', count: 3, timeoutMs: 3000 }, ctx)
          .catch(() => undefined);

        for (const [msg, err, data] of errorSpy.mock.calls) {
          // Mirrors how the framework composes the notification payload.
          const wire = JSON.stringify({
            message: msg,
            ...((data as Record<string, unknown>) ?? {}),
            ...(err ? { error: (err as Error).message } : {}),
          });
          expect(wire).not.toMatch(/ipify|Status:|503|leaky-body|ECONNREFUSED|1\.2\.3\.4/i);
        }
      }
    });

    it('sanitizes a non-JSON echo body', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON at position 0');
          },
          text: async () => '<html>gateway</html>',
        } as unknown as Response),
      );
      const error = (await run({ mode: 'public_ip', count: 3, timeoutMs: 3000 }).catch(
        (e: unknown) => e,
      )) as { message?: string };
      expect(error.message).toMatch(/egress-ip echo .* unavailable/i);
      expect(error.message).not.toMatch(/JSON|html/i);
    });
  });
});
