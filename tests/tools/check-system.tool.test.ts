/**
 * @fileoverview Tests for toolkit_check_system — each facet returns its own
 * shape keyed by `what`, reading os/process read-only. The memory headroom and
 * container-limit cases stub `os`, `process.availableMemory` /
 * `process.constrainedMemory`, and the cgroup usage file read (`node:fs`), so
 * the clamp runs against Node, Bun, bare-host, and cgroup v1/v2 figures alike.
 * The suite itself runs under Bun or Node, so every memory and os case pins the
 * runtime (`process.versions`) and `process.platform`. Under Bun on macOS the
 * tool spawns `vm_stat`; `execFile` is mocked to print a real capture, so the
 * parser and the headroom formula run as they do on a host.
 * @module tests/tools/check-system.tool.test
 */

import os from 'node:os';
import process from 'node:process';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSystemTool } from '@/mcp-server/tools/definitions/check-system.tool.js';
import { readCommonMark } from '../helpers/commonmark.js';

const { readFileSyncMock, execFileMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  execFileMock: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: readFileSyncMock,
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

/** `vm_stat` output captured on a 32 GiB Apple-silicon Mac (16 KiB pages), byte for byte. */
const VM_STAT_CAPTURE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     6085.
Pages active:                                 416091.
Pages inactive:                               413761.
Pages speculative:                               824.
Pages throttled:                                   0.
Pages wired down:                             326377.
Pages purgeable:                                   2.
"Translation faults":                    13351529021.
Pages copy-on-write:                       302552704.
Pages zero filled:                        5977074762.
Pages reactivated:                        3535376050.
Pages purged:                              145295594.
File-backed pages:                            280953.
Anonymous pages:                              549723.
Pages stored in compressor:                  1821838.
Pages occupied by compressor:                 879088.
Decompressions:                           3911892808.
Compressions:                             4135068496.
Pageins:                                   235433457.
Pageouts:                                    1215507.
Swapins:                                     4080017.
Swapouts:                                    5688247.
`;

/** (6085 free + 413761 inactive + 2 purgeable) × 16384; the 824 speculative pages stay out. */
const CAPTURE_AVAILABLE_BYTES = 6_878_789_632;
/** 6085 free pages × 16384 — what Bun's own `availableMemory()` and `os.freemem()` report there. */
const CAPTURE_FREE_BYTES = 99_696_640;

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;
type ExecFileOptions = { timeout?: number; signal?: AbortSignal };

/** `vm_stat` prints `stdout` and exits 0. */
const vmStatPrints = (stdout: string) =>
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _options: ExecFileOptions, callback: ExecFileCallback) =>
      callback(null, stdout, ''),
  );

/** `vm_stat` fails the way `execFile` reports it: a spawn errno, a timeout kill, or an exit status. */
const vmStatFails = (failure: {
  code: string | number | null;
  killed?: boolean;
  signal?: string | null;
}) =>
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _options: ExecFileOptions, callback: ExecFileCallback) =>
      callback(Object.assign(new Error('Command failed: /usr/bin/vm_stat'), failure), '', ''),
  );

/**
 * The OS refuses the spawn outright, as a sandbox denying the exec does: both
 * runtimes throw the errno from `execFile` itself and never call back.
 */
const vmStatSpawnThrows = (code: string) =>
  execFileMock.mockImplementation(() => {
    throw Object.assign(
      new Error(`${code}: operation not permitted, posix_spawn '/usr/bin/vm_stat'`),
      { code, errno: -1, syscall: 'spawn' },
    );
  });

const REAL_VERSIONS = Object.getOwnPropertyDescriptor(process, 'versions')!;
const REAL_VERSION = Object.getOwnPropertyDescriptor(process, 'version')!;
const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;

/**
 * Run as Bun 1.4.4 (which reports Node.js v26.3.0) or as Node.js 26.13.0, on
 * `platform`, as `process.versions`, `process.version`, and `process.platform`
 * report them. The real descriptors are restored after each test.
 */
function pinRuntime(runtime: 'bun' | 'node', platform: NodeJS.Platform) {
  const { bun: _bun, ...versions } = process.versions;
  Object.defineProperty(process, 'versions', {
    configurable: true,
    value:
      runtime === 'bun'
        ? { ...versions, node: '26.3.0', bun: '1.4.4' }
        : { ...versions, node: '26.13.0' },
  });
  Object.defineProperty(process, 'version', {
    configurable: true,
    value: runtime === 'bun' ? 'v26.3.0' : 'v26.13.0',
  });
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
}

const run = (what: string) =>
  checkSystemTool.handler(
    checkSystemTool.input.parse({ what }),
    createMockContext({ errors: checkSystemTool.errors }),
  );

describe('toolkit_check_system', () => {
  beforeEach(() => {
    // Real-host cases on a Mac under Bun reach the vm_stat spawn; serve them the capture.
    vmStatPrints(VM_STAT_CAPTURE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    readFileSyncMock.mockReset();
    execFileMock.mockReset();
    Object.defineProperty(process, 'versions', REAL_VERSIONS);
    Object.defineProperty(process, 'version', REAL_VERSION);
    Object.defineProperty(process, 'platform', REAL_PLATFORM);
  });

  it('reports os facts', async () => {
    const result = await run('os');
    expect(result.what).toBe('os');
    expect(result.os).toMatchObject({
      platform: expect.any(String),
      arch: expect.any(String),
      hostname: expect.any(String),
      nodeVersion: expect.stringMatching(/^v\d+/),
    });
    expect(result.cpu).toBeUndefined();
  });

  describe('os runtime identity', () => {
    /** Fixed host facts, so content[] can be compared as a whole block. */
    const stubHost = () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      vi.spyOn(os, 'release').mockReturnValue('27.2.0');
      vi.spyOn(os, 'arch').mockReturnValue('arm64');
      vi.spyOn(os, 'hostname').mockReturnValue('host.example');
      vi.spyOn(os, 'uptime').mockReturnValue(3600.4);
    };

    it.each([
      [
        'bun',
        { runtime: 'bun', runtimeVersion: '1.4.4', nodeVersion: 'v26.3.0' },
        '**Runtime:** bun 1.4.4 | **Node.js API:** v26.3.0',
      ],
      [
        'node',
        { runtime: 'node', runtimeVersion: '26.13.0', nodeVersion: 'v26.13.0' },
        '**Runtime:** node 26.13.0 | **Node.js API:** v26.13.0',
      ],
    ] as const)(
      'names the runtime under %s on both surfaces, beside the Node.js version it reports',
      async (runtime, fields, rendered) => {
        pinRuntime(runtime, 'darwin');
        stubHost();
        const result = await runToolContract(checkSystemTool, { what: 'os' });
        expect(checkSystemTool.output.parse(result.structuredContent)).toEqual({
          what: 'os',
          os: {
            platform: 'darwin',
            release: '27.2.0',
            arch: 'arm64',
            hostname: 'host.example',
            uptimeSeconds: 3600,
            ...fields,
          },
        });
        expect(result.content).toEqual([
          {
            type: 'text',
            text: `**Facet:** os\n**OS:** darwin 27.2.0 (arm64) | **Host:** host.example | **Uptime:** 3600s | ${rendered}`,
          },
        ]);
      },
    );
  });

  it('reports cpu facts', async () => {
    const result = await run('cpu');
    expect(result.what).toBe('cpu');
    expect(result.cpu!.cores).toBeGreaterThan(0);
  });

  it('reports memory facts with used = total - free', async () => {
    const result = await run('memory');
    const m = result.memory!;
    expect(m.usedBytes).toBe(m.totalBytes - m.freeBytes);
    expect(m.totalBytes).toBeGreaterThan(0);
  });

  it('reports the raw OS memory figures', async () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(34_359_738_368);
    vi.spyOn(os, 'freemem').mockReturnValue(23_150_592);
    const result = await run('memory');
    expect(result.memory).toMatchObject({
      totalBytes: 34_359_738_368,
      freeBytes: 23_150_592,
      usedBytes: 34_336_587_776,
    });
  });

  describe('memory headroom and container limit', () => {
    const CGROUP_V2 = '/sys/fs/cgroup/memory.current';
    const CGROUP_V1 = '/sys/fs/cgroup/memory/memory.usage_in_bytes';

    /** Pin the runtime and platform, then stub the host figures and the two runtime memory calls. */
    const host = (m: {
      runtime: 'bun' | 'node';
      platform: NodeJS.Platform;
      total: number;
      free: number;
      available: number;
      constrained: number;
    }) => {
      pinRuntime(m.runtime, m.platform);
      vi.spyOn(os, 'totalmem').mockReturnValue(m.total);
      vi.spyOn(os, 'freemem').mockReturnValue(m.free);
      vi.spyOn(process, 'availableMemory').mockReturnValue(m.available);
      vi.spyOn(process, 'constrainedMemory').mockReturnValue(m.constrained);
    };
    /** Serve cgroup usage files by path; any other path is absent, as on a bare host. */
    const cgroupFiles = (files: Record<string, string>) =>
      readFileSyncMock.mockImplementation((path: string) => {
        if (path in files) return files[path];
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
          code: 'ENOENT',
        });
      });

    it('reports availableMemory() as the headroom on unconstrained macOS under Node', async () => {
      // Node reports 0 for "no constraint"; freemem excludes inactive/purgeable pages.
      host({
        runtime: 'node',
        platform: 'darwin',
        total: 34_359_738_368,
        free: 23_150_592,
        available: 11_859_410_944,
        constrained: 0,
      });
      const { memory } = await run('memory');
      expect(memory).toEqual({
        totalBytes: 34_359_738_368,
        freeBytes: 23_150_592,
        usedBytes: 34_336_587_776,
        availableBytes: 11_859_410_944,
      });
      expect(readFileSyncMock).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('omits limitBytes when constrainedMemory() reports the full host RAM (Bun, unconstrained)', async () => {
      host({
        runtime: 'bun',
        platform: 'darwin',
        total: 34_359_738_368,
        free: CAPTURE_FREE_BYTES,
        available: CAPTURE_FREE_BYTES,
        constrained: 34_359_738_368,
      });
      const { memory } = await run('memory');
      expect(memory).not.toHaveProperty('limitBytes');
      expect(memory?.availableBytes).toBe(CAPTURE_AVAILABLE_BYTES);
      expect(readFileSyncMock).not.toHaveBeenCalled();
    });

    describe('under Bun on macOS, availableBytes comes from vm_stat', () => {
      const bunOnMac = () =>
        host({
          runtime: 'bun',
          platform: 'darwin',
          total: 34_359_738_368,
          free: CAPTURE_FREE_BYTES,
          available: CAPTURE_FREE_BYTES,
          constrained: 34_359_738_368,
        });

      it('sums free, inactive, and purgeable pages at the printed page size, on both surfaces', async () => {
        bunOnMac();
        const controller = new AbortController();
        const result = await runToolContract(
          checkSystemTool,
          { what: 'memory' },
          { context: { signal: controller.signal } },
        );
        expect(checkSystemTool.output.parse(result.structuredContent)).toEqual({
          what: 'memory',
          memory: {
            totalBytes: 34_359_738_368,
            freeBytes: CAPTURE_FREE_BYTES,
            usedBytes: 34_260_041_728,
            availableBytes: CAPTURE_AVAILABLE_BYTES,
          },
        });
        expect(result.content).toEqual([
          {
            type: 'text',
            text: [
              '**Facet:** memory',
              '**Memory available:** 6.41 GiB (availableBytes 6878789632) — no container memory limit',
              '**OS memory (raw):** 31.91 / 32.00 GiB used (0.09 GiB free) — totalBytes 34359738368, freeBytes 99696640, usedBytes 34260041728',
            ].join('\n'),
          },
        ]);
        // One spawn, by absolute path, bounded by a timeout and the caller's signal.
        expect(execFileMock).toHaveBeenCalledTimes(1);
        const [file, args, options] = execFileMock.mock.calls[0] as [
          string,
          string[],
          ExecFileOptions,
        ];
        expect([file, args]).toEqual(['/usr/bin/vm_stat', []]);
        expect(options.signal).toBe(controller.signal);
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.timeout).toBeLessThan(60_000);
      });

      it('reads the page size from the header rather than assuming 16 KiB', async () => {
        bunOnMac();
        vmStatPrints(
          VM_STAT_CAPTURE.replace('(page size of 16384 bytes)', '(page size of 4096 bytes)'),
        );
        const { memory } = await run('memory');
        // (6085 + 413761 + 2) × 4096
        expect(memory?.availableBytes).toBe(1_719_697_408);
      });

      it('clamps the vm_stat figure to the limit minus usage when a limit applies', async () => {
        host({
          runtime: 'bun',
          platform: 'darwin',
          total: 34_359_738_368,
          free: CAPTURE_FREE_BYTES,
          available: CAPTURE_FREE_BYTES,
          constrained: 268_435_456,
        });
        cgroupFiles({ [CGROUP_V2]: '104857600\n' });
        const { memory } = await run('memory');
        expect(memory).toMatchObject({
          availableBytes: 268_435_456 - 104_857_600,
          limitBytes: 268_435_456,
        });
        expect(execFileMock).toHaveBeenCalledTimes(1);
      });

      /** The recovery the `memory_stats_unavailable` contract entry declares. */
      const RECOVERY =
        'Retry once; if it fails again, treat memory headroom as unknown on this host rather than estimating it, and use the other facets, which do not read these statistics.';

      it('declares memory_stats_unavailable for every vm_stat failure the message reports', () => {
        expect(
          checkSystemTool.errors?.find((e) => e.reason === 'memory_stats_unavailable'),
        ).toEqual({
          reason: 'memory_stats_unavailable',
          code: JsonRpcErrorCode.ServiceUnavailable,
          when: 'what is memory, the server runs under Bun on macOS, and the host page statistics could not be read because the statistics command failed to start, did not finish in time, exited with a non-zero status, was terminated by a signal, or printed no page counts.',
          recovery: RECOVERY,
          thrownBy: 'service',
        });
      });
      const PREFIX = "Could not read the host's memory statistics: /usr/bin/vm_stat";
      const UNPARSEABLE = `${PREFIX} printed no page size or no free, inactive, or purgeable page count.`;

      it.each<[string, () => unknown, string]>([
        [
          'it cannot be spawned',
          () => vmStatFails({ code: 'ENOENT' }),
          `${PREFIX} could not be started (ENOENT).`,
        ],
        [
          'the OS refuses the spawn synchronously',
          () => vmStatSpawnThrows('EPERM'),
          `${PREFIX} could not be started (EPERM).`,
        ],
        [
          'it hits the timeout',
          () => vmStatFails({ code: null, killed: true, signal: 'SIGTERM' }),
          `${PREFIX} did not finish within 5000 ms.`,
        ],
        [
          'it exits non-zero',
          () => vmStatFails({ code: 1, killed: false, signal: null }),
          `${PREFIX} exited with status 1.`,
        ],
        [
          'it is killed by a signal',
          () => vmStatFails({ code: null, killed: false, signal: 'SIGKILL' }),
          `${PREFIX} exited with signal SIGKILL.`,
        ],
        ['it prints nothing', () => vmStatPrints(''), UNPARSEABLE],
        [
          'the page-size header is missing',
          () => vmStatPrints(VM_STAT_CAPTURE.split('\n').slice(1).join('\n')),
          UNPARSEABLE,
        ],
        ...['free', 'inactive', 'purgeable'].map((label): [string, () => unknown, string] => [
          `the ${label} count is missing`,
          () =>
            vmStatPrints(
              VM_STAT_CAPTURE.split('\n')
                .filter((line) => !line.startsWith(`Pages ${label}:`))
                .join('\n'),
            ),
          UNPARSEABLE,
        ]),
        [
          'a count is not a whole number',
          () => vmStatPrints(VM_STAT_CAPTURE.replace('Pages free:  ', 'Pages free: -')),
          UNPARSEABLE,
        ],
      ])(
        'fails as memory_stats_unavailable, never as free pages, when %s',
        async (_case, arrange, message) => {
          bunOnMac();
          arrange();
          const result = await runToolContract(checkSystemTool, { what: 'memory' });
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toEqual({
            error: {
              code: JsonRpcErrorCode.ServiceUnavailable,
              message,
              data: { reason: 'memory_stats_unavailable', recovery: { hint: RECOVERY } },
            },
          });
          const text = result.content
            .filter((block) => block.type === 'text')
            .map((block) => readCommonMark(block.text))
            .join('\n');
          expect(text).toContain(message);
          expect(text).toContain(RECOVERY);
          expect(text).not.toContain('availableBytes');
        },
      );

      it("rejects with the caller's abort reason when cancelled mid-spawn", async () => {
        bunOnMac();
        // Behaves as execFile does: an abort kills the child and calls back with an AbortError.
        execFileMock.mockImplementation(
          (_file: string, _args: string[], options: ExecFileOptions, callback: ExecFileCallback) =>
            options.signal?.addEventListener('abort', () =>
              callback(
                Object.assign(new Error('The operation was aborted'), {
                  name: 'AbortError',
                  code: 'ABORT_ERR',
                  cause: options.signal?.reason,
                }),
                '',
                '',
              ),
            ),
        );
        const controller = new AbortController();
        const pending = checkSystemTool.handler(
          checkSystemTool.input.parse({ what: 'memory' }),
          createMockContext({ errors: checkSystemTool.errors, signal: controller.signal }),
        );
        const reason = new Error('client cancelled the request');
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);
        expect(execFileMock).toHaveBeenCalledTimes(1);
      });

      it('settles a cancelled call as RequestCancelled carrying the abort reason', async () => {
        bunOnMac();
        const controller = new AbortController();
        execFileMock.mockImplementation(
          (
            _file: string,
            _args: string[],
            _options: ExecFileOptions,
            callback: ExecFileCallback,
          ) => {
            // The caller goes away while vm_stat runs; execFile then reports an AbortError.
            controller.abort(new Error('client cancelled the request'));
            callback(
              Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
              '',
              '',
            );
          },
        );
        const result = await runToolContract(
          checkSystemTool,
          { what: 'memory' },
          { context: { signal: controller.signal } },
        );
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.RequestCancelled,
            message: 'client cancelled the request',
          },
        });
        expect(readCommonMark((result.content[0] as { text: string }).text)).toContain(
          'client cancelled the request',
        );
      });
    });

    it.each(['linux', 'win32'] as const)(
      'keeps availableMemory() under Bun on %s without spawning vm_stat',
      async (platform) => {
        host({
          runtime: 'bun',
          platform,
          total: 8_319_500_288,
          free: 6_207_303_680,
          available: 6_207_303_680,
          constrained: 8_319_500_288,
        });
        const { memory } = await run('memory');
        expect(memory).toEqual({
          totalBytes: 8_319_500_288,
          freeBytes: 6_207_303_680,
          usedBytes: 2_112_196_608,
          availableBytes: 6_207_303_680,
        });
        expect(execFileMock).not.toHaveBeenCalled();
      },
    );

    it('omits limitBytes when constrainedMemory() exceeds the host RAM (Node, unlimited cgroup)', async () => {
      // node:24-slim with memory.max = "max" reports 2^64 − 1.
      host({
        runtime: 'node',
        platform: 'linux',
        total: 8_319_500_288,
        free: 6_000_000_000,
        available: 6_000_000_000,
        constrained: 2 ** 64 - 1,
      });
      const { memory } = await run('memory');
      expect(memory).not.toHaveProperty('limitBytes');
      expect(memory?.availableBytes).toBe(6_000_000_000);
    });

    it("clamps Bun's host-wide availableMemory() to the cgroup v2 limit minus usage", async () => {
      // oven/bun:1.4.0-slim under -m 256m: availableMemory() is host free memory.
      host({
        runtime: 'bun',
        platform: 'linux',
        total: 8_319_500_288,
        free: 6_510_546_944,
        available: 6_510_546_944,
        constrained: 268_435_456,
      });
      cgroupFiles({ [CGROUP_V2]: '104857600\n' });
      const { memory } = await run('memory');
      expect(memory).toEqual({
        totalBytes: 8_319_500_288,
        freeBytes: 6_510_546_944,
        usedBytes: 1_808_953_344,
        availableBytes: 268_435_456 - 104_857_600,
        limitBytes: 268_435_456,
      });
      expect(memory!.availableBytes).toBeLessThanOrEqual(268_435_456);
    });

    it("keeps Node's container-aware availableMemory() when it is already below limit − usage", async () => {
      host({
        runtime: 'node',
        platform: 'linux',
        total: 8_319_500_288,
        free: 6_459_957_248,
        available: 163_041_280,
        constrained: 268_435_456,
      });
      cgroupFiles({ [CGROUP_V2]: '52428800\n' });
      const { memory } = await run('memory');
      expect(memory).toMatchObject({ availableBytes: 163_041_280, limitBytes: 268_435_456 });
    });

    it('falls back to the cgroup v1 usage file when v2 is absent', async () => {
      host({
        runtime: 'bun',
        platform: 'linux',
        total: 8_319_500_288,
        free: 6_510_546_944,
        available: 6_510_546_944,
        constrained: 268_435_456,
      });
      cgroupFiles({ [CGROUP_V1]: '200000000\n' });
      const { memory } = await run('memory');
      expect(memory?.availableBytes).toBe(268_435_456 - 200_000_000);
      expect(readFileSyncMock.mock.calls.map(([path]) => path)).toEqual([CGROUP_V2, CGROUP_V1]);
    });

    it('bounds availableBytes by the limit when no usage file is readable', async () => {
      host({
        runtime: 'bun',
        platform: 'linux',
        total: 8_319_500_288,
        free: 6_510_546_944,
        available: 6_510_546_944,
        constrained: 268_435_456,
      });
      cgroupFiles({});
      const { memory } = await run('memory');
      expect(memory).toMatchObject({ availableBytes: 268_435_456, limitBytes: 268_435_456 });
    });

    it('reports zero headroom when usage has reached the limit', async () => {
      host({
        runtime: 'bun',
        platform: 'linux',
        total: 8_319_500_288,
        free: 6_510_546_944,
        available: 6_510_546_944,
        constrained: 268_435_456,
      });
      cgroupFiles({ [CGROUP_V2]: '270000000\n' });
      const { memory } = await run('memory');
      expect(memory?.availableBytes).toBe(0);
    });

    it('carries both new fields in structuredContent and content[]', async () => {
      host({
        runtime: 'bun',
        platform: 'linux',
        total: 8_319_500_288,
        free: 6_510_546_944,
        available: 6_510_546_944,
        constrained: 268_435_456,
      });
      cgroupFiles({ [CGROUP_V2]: '104857600\n' });
      const result = await runToolContract(checkSystemTool, { what: 'memory' });
      expect(result.structuredContent).toMatchObject({
        what: 'memory',
        memory: { availableBytes: 163_577_856, limitBytes: 268_435_456 },
      });
      expect(result.structuredContent).toEqual(expect.schemaMatching(checkSystemTool.output));
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain('availableBytes 163577856');
      expect(text).toContain('limitBytes 268435456');
    });

    it('says there is no container limit in content[] when limitBytes is absent', async () => {
      host({
        runtime: 'node',
        platform: 'darwin',
        total: 34_359_738_368,
        free: 23_150_592,
        available: 11_859_410_944,
        constrained: 0,
      });
      const result = await runToolContract(checkSystemTool, { what: 'memory' });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('availableBytes 11859410944');
      expect(text).toContain('no container memory limit');
      expect(text).not.toContain('limitBytes');
    });
  });

  it('reports load facts', async () => {
    const result = await run('load');
    expect(result.load).toMatchObject({
      avg1: expect.any(Number),
      avg5: expect.any(Number),
      avg15: expect.any(Number),
    });
  });

  it('reports interfaces, all non-internal', async () => {
    const result = await run('interfaces');
    expect(result.what).toBe('interfaces');
    expect(Array.isArray(result.interfaces)).toBe(true);
    for (const iface of result.interfaces!) {
      expect(iface.internal).toBe(false);
    }
  });

  it('populates only the requested facet, leaving the others absent', async () => {
    // Facet gating: a cpu request carries cpu and nothing else.
    const result = await run('cpu');
    expect(result.cpu).toBeDefined();
    expect(result.os).toBeUndefined();
    expect(result.memory).toBeUndefined();
    expect(result.load).toBeUndefined();
    expect(result.interfaces).toBeUndefined();
  });

  it('rejects an unknown facet at the schema boundary', () => {
    expect(checkSystemTool.input.safeParse({ what: 'disk' }).success).toBe(false);
    expect(checkSystemTool.input.safeParse({}).success).toBe(false);
  });

  it('output conforms to the declared schema', async () => {
    const result = await run('memory');
    expect(result).toEqual(expect.schemaMatching(checkSystemTool.output));
  });

  it.each(['os', 'cpu', 'memory', 'load', 'interfaces'])(
    'output conforms to the declared schema for the %s facet',
    async (what) => {
      const result = await run(what);
      expect(result).toEqual(expect.schemaMatching(checkSystemTool.output));
    },
  );

  it('format renders the cpu facet fields', () => {
    const blocks = checkSystemTool.format!({
      what: 'cpu',
      cpu: { model: 'Apple M3', cores: 8, speedMhz: 2400 },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Apple M3');
    expect(text).toContain('8');
    expect(text).toContain('2400');
  });

  it('format renders the memory facet with raw byte counts', () => {
    const text = (
      checkSystemTool.format!({
        what: 'memory',
        memory: {
          totalBytes: 17179869184,
          freeBytes: 8589934592,
          usedBytes: 8589934592,
          availableBytes: 9663676416,
          limitBytes: 12884901888,
        },
      })[0] as { text: string }
    ).text;
    // The byte fields the schema declares appear verbatim (format-parity).
    expect(text).toContain('17179869184');
    expect(text).toContain('8589934592');
    expect(text).toContain('availableBytes 9663676416');
    expect(text).toContain('limitBytes 12884901888');
  });

  it('format lists each network interface', () => {
    const text = (
      checkSystemTool.format!({
        what: 'interfaces',
        interfaces: [{ name: 'en0', address: '192.0.2.5', family: 'IPv4', internal: false }],
      })[0] as { text: string }
    ).text;
    expect(text).toContain('en0');
    expect(text).toContain('192.0.2.5');
    expect(text).toContain('IPv4');
  });
});
