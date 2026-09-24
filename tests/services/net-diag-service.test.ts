/**
 * @fileoverview Tests for NetDiagService's probe internals — the OS-binary
 * command lines per platform and address family, the ping/traceroute output
 * parsers (RTT and packet loss), the split between a real no-reply and a probe
 * that never ran, the TCP connect outcome, the declared failures and their
 * recovery metadata, and the sanitized egress-IP provider failure.
 * `node:child_process`, `node:dns/promises`, and `node:net`'s `connect` are
 * mocked so no probe, DNS query, or packet leaves the host; `fetch` is stubbed
 * for the egress-IP echo. The private-range gate itself is covered by
 * net-diag-gate.test.ts.
 * @module tests/services/net-diag-service.test
 */

import { EventEmitter } from 'node:events';
import process from 'node:process';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { checkNetworkTool } from '@/mcp-server/tools/definitions/check-network.tool.js';
import { getNetDiagService, initNetDiagService } from '@/services/network/net-diag-service.js';

const { execFileMock, lookupMock, connectMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  lookupMock: vi.fn(),
  connectMock: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));
vi.mock('node:net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:net')>()),
  connect: connectMock,
}));

/** The contract entries under test — asserted against, never re-typed inline. */
const recoveryOf = (reason: string) =>
  checkNetworkTool.errors!.find((e) => e.reason === reason)!.recovery as string;
const UNREACHABLE_RECOVERY = recoveryOf('unreachable');

/**
 * A stand-in socket: `connect()` hands it back, and the service's listeners
 * receive whichever event the test schedules for the next turn of the loop.
 */
class FakeSocket extends EventEmitter {
  setTimeout = vi.fn();
  destroy = vi.fn();
}
const socketEmits = (event: 'connect' | 'timeout' | 'error', payload?: unknown) => {
  const socket = new FakeSocket();
  connectMock.mockImplementation(() => {
    setImmediate(() => socket.emit(event, payload));
    return socket;
  });
  return socket;
};
const socketError = (code: string) =>
  Object.assign(new Error(`connect ${code} 8.8.8.8:443`), { code, syscall: 'connect' });

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

/**
 * The binary ran and exited non-zero. Node's promisified execFile rejects with
 * the numeric exit status on `code` and the captured streams attached.
 */
const spawnExits = (code: number, stdout: string, stderr = '') =>
  execFileMock.mockImplementation(
    (cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) =>
      cb(Object.assign(new Error(`Command failed: ${cmd}`), { code, stdout, stderr })),
  );

/** The binary never ran: libuv reports a string errno on `code`, with empty streams. */
const spawnMissing = (code: 'ENOENT' | 'EACCES') =>
  execFileMock.mockImplementation(
    (cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) =>
      cb(
        Object.assign(new Error(`spawn ${cmd} ${code}`), {
          code,
          errno: -2,
          syscall: `spawn ${cmd}`,
          path: cmd,
          stdout: '',
          stderr: '',
        }),
      ),
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

/*
 * Captured transcripts, verbatim. macOS 27 ping (BSD) and Linux iputils
 * 20240905 (Debian trixie); 198.51.100.1 is TEST-NET-2, which never answers.
 */
const PING_MACOS_NO_REPLY = `PING 198.51.100.1 (198.51.100.1): 56 data bytes
Request timeout for icmp_seq 0

--- 198.51.100.1 ping statistics ---
2 packets transmitted, 0 packets received, 100.0% packet loss
`;

const PING_LINUX = `PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=63 time=507 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=63 time=10.5 ms
64 bytes from 1.1.1.1: icmp_seq=3 ttl=63 time=11.9 ms

--- 1.1.1.1 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2008ms
rtt min/avg/max/mdev = 10.538/176.422/506.842/233.642 ms
`;

const PING_LINUX_NO_REPLY = `PING 198.51.100.1 (198.51.100.1) 56(84) bytes of data.

--- 198.51.100.1 ping statistics ---
2 packets transmitted, 0 received, 100% packet loss, time 1012ms

`;

/** Windows prints no round-trip block when nothing came back. */
const PING_WINDOWS_NO_REPLY = `
Pinging 8.8.8.8 with 32 bytes of data:
Request timed out.
Request timed out.
Request timed out.

Ping statistics for 8.8.8.8:
    Packets: Sent = 3, Received = 0, Lost = 3 (100% loss),
`;

/** Summary lines for partial loss, in each platform's own format. */
const PING_MACOS_PARTIAL = `--- 8.8.8.8 ping statistics ---
3 packets transmitted, 2 packets received, 33.3% packet loss
round-trip min/avg/max/stddev = 10.100/11.000/11.900/0.900 ms
`;
const PING_LINUX_PARTIAL = `--- 8.8.8.8 ping statistics ---
3 packets transmitted, 2 received, 33.3333% packet loss, time 2003ms
rtt min/avg/max/mdev = 10.538/11.200/11.862/0.662 ms
`;
/**
 * iputils `-c 3 -w 1` against a live host, captured verbatim: the deadline
 * cut the run to one echo, which was answered. With both -c and -w set,
 * iputils exits 1 whenever fewer than count replies arrive — partial loss
 * included — so a non-zero exit alone does not mean the host is down.
 */
const PING_LINUX_DEADLINE_CUT = `PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=63 time=508 ms

--- 1.1.1.1 ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 508.139/508.139/508.139/0.000 ms
`;
const PING_LINUX_ERRORS = `--- 8.8.8.8 ping statistics ---
3 packets transmitted, 0 received, +3 errors, 100% packet loss, time 2046ms
`;
const PING_LINUX_DUPLICATES = `--- 8.8.8.8 ping statistics ---
3 packets transmitted, 3 received, +1 duplicates, 0% packet loss, time 2003ms
rtt min/avg/max/mdev = 10.538/11.200/11.862/0.662 ms
`;
const PING_WINDOWS_PARTIAL = `
Ping statistics for 8.8.8.8:
    Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),
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
    connectMock.mockReset();
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

    it('gives Windows ping a spawn timeout that outlasts its 1 s send interval', async () => {
      // Windows has no overall deadline flag and sends echoes about 1 s apart,
      // so ten echoes take ~10 s however short the per-reply -w is. A backstop
      // of count × timeoutMs (+2 s) would kill a live host's run mid-way.
      setPlatform('win32');
      spawnSucceeds(PING_WINDOWS);
      await run({ mode: 'ping', target: '8.8.8.8', count: 10, timeoutMs: 100 });
      const opts = execFileMock.mock.calls[0]?.[2] as { timeout: number };
      expect(opts.timeout).toBeGreaterThan(10 * 1000);
    });

    it('reads the average RTT from Windows ping statistics, not the first reply', async () => {
      setPlatform('win32');
      spawnSucceeds(PING_WINDOWS);
      // Replies are 10/12/11 ms; the summary average is 11 ms. Taking the first
      // reply would report 10.
      const result = await run({ mode: 'ping', target: '8.8.8.8', count: 3, timeoutMs: 3000 });
      expect(result).toMatchObject({ rttMs: 11 });
    });

    it.each([
      ['darwin', 2, PING_MACOS_NO_REPLY],
      ['linux', 1, PING_LINUX_NO_REPLY],
    ] as const)(
      'reports a real no-reply on %s (exit %i with a loss summary) as reachable:false',
      async (platform, exitCode, stdout) => {
        setPlatform(platform);
        spawnExits(exitCode, stdout);
        // The probed address is public (the TEST-NET transcript would trip the
        // private-range gate); only the captured output matters here.
        const result = await run({ mode: 'ping', target: '8.8.8.8', count: 2, timeoutMs: 1000 });
        expect(result).toMatchObject({ mode: 'ping', target: '8.8.8.8', reachable: false });
      },
    );

    it('keeps the no-reply result a result — packet counts, no RTT', async () => {
      setPlatform('darwin');
      spawnExits(2, PING_MACOS_NO_REPLY);
      const result = await run({ mode: 'ping', target: '8.8.8.8', count: 2, timeoutMs: 1000 });
      expect(result).toEqual({
        mode: 'ping',
        target: '8.8.8.8',
        reachable: false,
        sent: 2,
        received: 0,
        packetLossPercent: 100,
      });
    });
  });

  describe('ping — a probe that never ran is an error, not a down host', () => {
    it.each(['ENOENT', 'EACCES'] as const)(
      'throws unreachable naming the binary when the spawn fails with %s',
      async (errno) => {
        setPlatform('linux');
        spawnMissing(errno);
        const error = (await run({
          mode: 'ping',
          target: '8.8.8.8',
          count: 3,
          timeoutMs: 3000,
        }).catch((e: unknown) => e)) as { message?: string; data?: Record<string, unknown> };
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toMatch(/\bping\b/);
        expect(error.message).toContain(errno);
        expect(error.data).toMatchObject({
          reason: 'unreachable',
          recovery: { hint: UNREACHABLE_RECOVERY },
        });
      },
    );

    it('throws unreachable carrying stderr when ping exits without a loss summary', async () => {
      // macOS ping handed an IPv6 literal: exit 68, nothing on stdout.
      setPlatform('darwin');
      spawnExits(68, '', 'ping: cannot resolve 2606:4700:4700::1111: Unknown host\n');
      const error = (await run({
        mode: 'ping',
        target: '8.8.8.8',
        count: 1,
        timeoutMs: 1000,
      }).catch((e: unknown) => e)) as { message?: string; data?: Record<string, unknown> };
      expect(error.message).toContain('ping: cannot resolve 2606:4700:4700::1111: Unknown host');
      expect(error.data).toMatchObject({ reason: 'unreachable' });
    });

    it('throws unreachable, saying the output could not be interpreted, for a summary in another language', async () => {
      // A German Windows prints "Gesendet/Empfangen", which no summary pattern
      // reads. The run cannot be told apart from a failure, so it must not be
      // reported as a down host.
      setPlatform('win32');
      spawnExits(
        1,
        `
Ping wird ausgeführt für 8.8.8.8 mit 32 Bytes Daten:
Zeitüberschreitung der Anforderung.

Ping-Statistik für 8.8.8.8:
    Pakete: Gesendet = 1, Empfangen = 0, Verloren = 1
    (100% Verlust),
`,
      );
      await expect(
        run({ mode: 'ping', target: '8.8.8.8', count: 1, timeoutMs: 1000 }),
      ).rejects.toMatchObject({
        message:
          'ping exited with status 1, and its output could not be interpreted as a result (target 8.8.8.8).',
        data: { reason: 'unreachable', recovery: { hint: UNREACHABLE_RECOVERY } },
      });
    });

    it('throws unreachable for a usage error (exit 64, usage text on stderr)', async () => {
      setPlatform('darwin');
      spawnExits(64, '', 'usage: ping [-AaDdfnoQqRrv] [-c count] [-G sweepmaxsize]\n');
      await expect(
        run({ mode: 'ping', target: '8.8.8.8', count: 1, timeoutMs: 1000 }),
      ).rejects.toMatchObject({ data: { reason: 'unreachable' } });
    });

    it('throws unreachable when ping is stopped at the spawn timeout before its summary', async () => {
      setPlatform('linux');
      execFileMock.mockImplementation(
        (cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) =>
          cb(
            Object.assign(new Error(`Command failed: ${cmd}`), {
              code: null,
              killed: true,
              signal: 'SIGTERM',
              stdout: 'PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.\n',
              stderr: '',
            }),
          ),
      );
      const error = (await run({
        mode: 'ping',
        target: '8.8.8.8',
        count: 1,
        timeoutMs: 1000,
      }).catch((e: unknown) => e)) as { message?: string; data?: Record<string, unknown> };
      expect(error.message).toMatch(/did not finish/i);
      expect(error.data).toMatchObject({ reason: 'unreachable' });
    });

    it('lets a caller cancellation bubble unchanged', async () => {
      setPlatform('linux');
      const controller = new AbortController();
      controller.abort();
      const abortError = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
      });
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) => cb(abortError),
      );
      const error = await getNetDiagService()
        .run(
          { mode: 'ping', target: '8.8.8.8', count: 1, timeoutMs: 1000 },
          createMockContext({ errors: checkNetworkTool.errors, signal: controller.signal }),
        )
        .catch((e: unknown) => e);
      expect(error).toBe(abortError);
    });
  });

  describe('ping — IPv6 binary selection', () => {
    it('runs ping6 for an IPv6 target on darwin, without the BSD -t flag', async () => {
      // macOS ping6 has no deadline flag — its -t requests Node Information.
      setPlatform('darwin');
      spawnSucceeds(PING_BSD);
      await run({ mode: 'ping', target: '2606:4700:4700::1111', count: 3, timeoutMs: 3000 });
      expect(spawnedWith()).toEqual(['ping6', ['-c', '3', '2606:4700:4700::1111']]);
    });

    it('gives ping6 time to finish its own final-reply wait, so a no-reply still summarizes', async () => {
      // ping6 sends one echo a second, then waits a fixed 10 s for the last
      // reply: `ping6 -c 2` to a silent address exits after 12.03 s on macOS 27.
      // A shorter spawn timeout would kill it before the loss summary prints.
      setPlatform('darwin');
      spawnSucceeds(PING_BSD);
      await run({ mode: 'ping', target: '2606:4700:4700::1111', count: 2, timeoutMs: 100 });
      const opts = execFileMock.mock.calls[0]?.[2] as { timeout: number };
      expect(opts.timeout).toBeGreaterThan(2 * 1000 + 10_000);
    });

    it('runs ping6 when a hostname resolves to an IPv6 address on darwin', async () => {
      setPlatform('darwin');
      lookupMock.mockResolvedValue({
        address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c',
        family: 6,
      });
      spawnSucceeds(PING_BSD);
      await run({ mode: 'ping', target: 'example.com', count: 1, timeoutMs: 1000 });
      expect(spawnedWith()).toEqual([
        'ping6',
        ['-c', '1', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
      ]);
    });

    it('names ping6 in the error when it is the binary that is missing', async () => {
      setPlatform('darwin');
      spawnMissing('ENOENT');
      await expect(
        run({ mode: 'ping', target: '2606:4700:4700::1111', count: 1, timeoutMs: 1000 }),
      ).rejects.toThrow(/\bping6\b/);
    });

    it('keeps the unified ping binary and flag set for IPv6 on linux', async () => {
      setPlatform('linux');
      spawnSucceeds(PING_LINUX);
      await run({ mode: 'ping', target: '2606:4700:4700::1111', count: 3, timeoutMs: 3000 });
      expect(spawnedWith()).toEqual(['ping', ['-c', '3', '-w', '9', '2606:4700:4700::1111']]);
    });

    it('keeps the Windows command line for IPv6 on win32', async () => {
      setPlatform('win32');
      spawnSucceeds(PING_WINDOWS);
      await run({ mode: 'ping', target: '2606:4700:4700::1111', count: 3, timeoutMs: 3000 });
      expect(spawnedWith()).toEqual(['ping', ['-n', '3', '-w', '3000', '2606:4700:4700::1111']]);
    });
  });

  describe('ping — packet loss from the summary line', () => {
    it.each([
      ['darwin', 'macOS, all replies', 0, PING_BSD, { sent: 3, received: 3, packetLossPercent: 0 }],
      [
        'linux',
        'Linux, all replies',
        0,
        PING_LINUX,
        { sent: 3, received: 3, packetLossPercent: 0 },
      ],
      [
        'win32',
        'Windows, all replies',
        0,
        PING_WINDOWS,
        { sent: 3, received: 3, packetLossPercent: 0 },
      ],
      [
        'darwin',
        'macOS, partial loss',
        0,
        PING_MACOS_PARTIAL,
        { sent: 3, received: 2, packetLossPercent: 33.3 },
      ],
      [
        'linux',
        'Linux, partial loss (iputils exits 1)',
        1,
        PING_LINUX_PARTIAL,
        { sent: 3, received: 2, packetLossPercent: 33.3 },
      ],
      [
        'win32',
        'Windows, partial loss',
        0,
        PING_WINDOWS_PARTIAL,
        { sent: 4, received: 3, packetLossPercent: 25 },
      ],
      [
        'linux',
        'Linux, duplicates counted once',
        0,
        PING_LINUX_DUPLICATES,
        { sent: 3, received: 3, packetLossPercent: 0 },
      ],
      [
        'darwin',
        'macOS, total loss',
        2,
        PING_MACOS_NO_REPLY,
        { sent: 2, received: 0, packetLossPercent: 100 },
      ],
      [
        'linux',
        'Linux, total loss',
        1,
        PING_LINUX_NO_REPLY,
        { sent: 2, received: 0, packetLossPercent: 100 },
      ],
      [
        'linux',
        'Linux, total loss with errors',
        1,
        PING_LINUX_ERRORS,
        { sent: 3, received: 0, packetLossPercent: 100 },
      ],
      [
        'win32',
        'Windows, total loss',
        1,
        PING_WINDOWS_NO_REPLY,
        { sent: 3, received: 0, packetLossPercent: 100 },
      ],
    ] as const)('%s — %s', async (platform, _label, exitCode, stdout, expected) => {
      setPlatform(platform);
      if (exitCode === 0) spawnSucceeds(stdout);
      else spawnExits(exitCode, stdout);
      const result = await run({ mode: 'ping', target: '8.8.8.8', count: 3, timeoutMs: 3000 });
      // reachable follows the replies, not the exit status.
      expect(result).toMatchObject({ ...expected, reachable: expected.received > 0 });
    });

    it('reports a Linux run that got replies but exited 1 as reachable, with its RTT', async () => {
      setPlatform('linux');
      spawnExits(1, PING_LINUX_DEADLINE_CUT);
      const result = await run({ mode: 'ping', target: '1.1.1.1', count: 3, timeoutMs: 300 });
      expect(result).toEqual({
        mode: 'ping',
        target: '1.1.1.1',
        reachable: true,
        rttMs: 508.139,
        sent: 1,
        received: 1,
        packetLossPercent: 0,
      });
    });

    it('omits the packet fields when a successful run prints no summary', async () => {
      setPlatform('darwin');
      spawnSucceeds('64 bytes from 8.8.8.8: icmp_seq=0 ttl=118 time=11.234 ms\n');
      const result = await run({ mode: 'ping', target: '8.8.8.8', count: 1, timeoutMs: 1000 });
      expect(result).toEqual({ mode: 'ping', target: '8.8.8.8', reachable: true, rttMs: 11.234 });
    });
  });

  describe('required fields', () => {
    it('throws missing_target with its recovery when a target-bearing mode has no target', async () => {
      const error = (await run({ mode: 'traceroute', count: 3, timeoutMs: 3000 }).catch(
        (e: unknown) => e,
      )) as { message?: string; data?: Record<string, unknown> };
      expect(error.message).toMatch(/target is required for mode "traceroute"/);
      expect(error.data).toMatchObject({
        reason: 'missing_target',
        recovery: { hint: recoveryOf('missing_target') },
      });
    });

    it('throws missing_port with its recovery before resolving or connecting', async () => {
      const error = (await run({
        mode: 'connectivity',
        target: 'example.com',
        count: 3,
        timeoutMs: 3000,
      }).catch((e: unknown) => e)) as { message?: string; data?: Record<string, unknown> };
      expect(error.message).toMatch(/port is required/);
      expect(error.data).toMatchObject({
        reason: 'missing_port',
        recovery: { hint: recoveryOf('missing_port') },
      });
      expect(lookupMock).not.toHaveBeenCalled();
      expect(connectMock).not.toHaveBeenCalled();
    });
  });

  describe('connectivity — connect outcome', () => {
    const probe = () =>
      run({ mode: 'connectivity', target: '8.8.8.8', port: 443, count: 3, timeoutMs: 2000 });

    it('reports open with the connect time on a successful connect', async () => {
      const socket = socketEmits('connect');
      const result = await probe();
      expect(result).toMatchObject({
        mode: 'connectivity',
        target: '8.8.8.8',
        reachable: true,
        outcome: 'open',
        rttMs: expect.any(Number),
      });
      expect((result as { rttMs: number }).rttMs).toBeGreaterThanOrEqual(0);
      expect(connectMock).toHaveBeenCalledWith({ host: '8.8.8.8', port: 443 });
      expect(socket.setTimeout).toHaveBeenCalledWith(2000);
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('reports timeout when the socket timeout fires', async () => {
      socketEmits('timeout');
      expect(await probe()).toEqual({
        mode: 'connectivity',
        target: '8.8.8.8',
        reachable: false,
        outcome: 'timeout',
      });
    });

    it.each([
      ['ECONNREFUSED', 'refused'],
      ['EHOSTUNREACH', 'unreachable'],
      ['ENETUNREACH', 'unreachable'],
      ['ECONNRESET', 'unreachable'],
      ['EADDRNOTAVAIL', 'unreachable'],
    ] as const)('maps a socket %s error to outcome %s, with no rttMs', async (code, outcome) => {
      socketEmits('error', socketError(code));
      expect(await probe()).toEqual({
        mode: 'connectivity',
        target: '8.8.8.8',
        reachable: false,
        outcome,
      });
    });

    it('rejects with the abort reason on caller cancellation, not a connect outcome', async () => {
      const socket = new FakeSocket();
      connectMock.mockImplementation(() => socket);
      const controller = new AbortController();
      const pending = getNetDiagService()
        .run(
          { mode: 'connectivity', target: '8.8.8.8', port: 443, count: 3, timeoutMs: 2000 },
          createMockContext({ errors: checkNetworkTool.errors, signal: controller.signal }),
        )
        .catch((e: unknown) => e);
      await vi.waitFor(() => expect(connectMock).toHaveBeenCalled());
      const reason = new Error('client cancelled');
      controller.abort(reason);
      expect(await pending).toBe(reason);
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('rejects without connecting when the caller cancelled before the probe started', async () => {
      // A cancellation that lands during DNS resolution has already fired its
      // abort event by the time the probe subscribes, so the listener never runs.
      socketEmits('connect');
      const controller = new AbortController();
      const reason = new Error('client cancelled');
      controller.abort(reason);
      const error = await getNetDiagService()
        .run(
          { mode: 'connectivity', target: '8.8.8.8', port: 443, count: 3, timeoutMs: 2000 },
          createMockContext({ errors: checkNetworkTool.errors, signal: controller.signal }),
        )
        .catch((e: unknown) => e);
      expect(error).toBe(reason);
      expect(connectMock).not.toHaveBeenCalled();
    });

    it('settles on the first event only', async () => {
      const socket = new FakeSocket();
      connectMock.mockImplementation(() => {
        setImmediate(() => {
          socket.emit('error', socketError('ECONNREFUSED'));
          socket.emit('timeout');
        });
        return socket;
      });
      expect(await probe()).toMatchObject({ outcome: 'refused' });
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

    it('runs traceroute6 with the unix flag set for an IPv6 target on darwin', async () => {
      setPlatform('darwin');
      spawnSucceeds(' 1  2001:4860:4860::8888  1.100 ms\n');
      await run({ mode: 'traceroute', target: '2606:4700:4700::1111', count: 3, timeoutMs: 3000 });
      expect(spawnedWith()).toEqual([
        'traceroute6',
        ['-n', '-w', '1', '-q', '1', '-m', '30', '2606:4700:4700::1111'],
      ]);
    });

    it('keeps traceroute for an IPv6 target on linux', async () => {
      setPlatform('linux');
      spawnSucceeds(' 1  2001:4860:4860::8888  1.100 ms\n');
      await run({ mode: 'traceroute', target: '2606:4700:4700::1111', count: 3, timeoutMs: 3000 });
      expect(spawnedWith()[0]).toBe('traceroute');
    });

    it('keeps traceroute for an IPv4 target on darwin', async () => {
      setPlatform('darwin');
      spawnSucceeds(TRACEROUTE_UNIX);
      await run({ mode: 'traceroute', target: '8.8.8.8', count: 3, timeoutMs: 3000 });
      expect(spawnedWith()).toEqual([
        'traceroute',
        ['-n', '-w', '1', '-q', '1', '-m', '30', '8.8.8.8'],
      ]);
    });

    it('carries stderr when traceroute ran but exited without a result', async () => {
      setPlatform('darwin');
      spawnExits(1, '', 'connect: No route to host\n');
      const error = (await run({
        mode: 'traceroute',
        target: '2606:4700:4700::1111',
        count: 3,
        timeoutMs: 3000,
      }).catch((e: unknown) => e)) as { message?: string; data?: Record<string, unknown> };
      expect(error.message).toBe(
        'traceroute6 exited with status 1, and its output could not be interpreted as a result: connect: No route to host (target 2606:4700:4700::1111).',
      );
      expect(error.data).toMatchObject({ reason: 'unreachable' });
    });

    it('names traceroute6 when it is the binary that cannot run', async () => {
      setPlatform('darwin');
      spawnMissing('ENOENT');
      await expect(
        run({ mode: 'traceroute', target: '2606:4700:4700::1111', count: 3, timeoutMs: 3000 }),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/\btraceroute6\b/),
        data: { reason: 'unreachable' },
      });
    });

    it('lets a caller cancellation bubble unchanged, not as a binary that cannot run', async () => {
      setPlatform('darwin');
      const controller = new AbortController();
      controller.abort();
      const abortError = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
      });
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) => cb(abortError),
      );
      const error = await getNetDiagService()
        .run(
          { mode: 'traceroute', target: '8.8.8.8', count: 3, timeoutMs: 3000 },
          createMockContext({ errors: checkNetworkTool.errors, signal: controller.signal }),
        )
        .catch((e: unknown) => e);
      expect(error).toBe(abortError);
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
