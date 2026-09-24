/**
 * @fileoverview Tests for toolkit_check_system — each facet returns its own
 * shape keyed by `what`, reading os/process read-only. The memory headroom and
 * container-limit cases stub `os`, `process.availableMemory` /
 * `process.constrainedMemory`, and the cgroup usage file read (`node:fs`), so
 * the clamp runs against Node, Bun, bare-host, and cgroup v1/v2 figures alike.
 * @module tests/tools/check-system.tool.test
 */

import os from 'node:os';
import process from 'node:process';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSystemTool } from '@/mcp-server/tools/definitions/check-system.tool.js';

const { readFileSyncMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: readFileSyncMock,
}));

const run = (what: string) =>
  checkSystemTool.handler(checkSystemTool.input.parse({ what }), createMockContext());

describe('toolkit_check_system', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    readFileSyncMock.mockReset();
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

    /** Stub the host figures and the two runtime memory calls. */
    const host = (m: { total: number; free: number; available: number; constrained: number }) => {
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
      host({ total: 34_359_738_368, free: 23_150_592, available: 11_859_410_944, constrained: 0 });
      const { memory } = await run('memory');
      expect(memory).toEqual({
        totalBytes: 34_359_738_368,
        freeBytes: 23_150_592,
        usedBytes: 34_336_587_776,
        availableBytes: 11_859_410_944,
      });
      expect(readFileSyncMock).not.toHaveBeenCalled();
    });

    it('omits limitBytes when constrainedMemory() reports the full host RAM (Bun, unconstrained)', async () => {
      host({
        total: 34_359_738_368,
        free: 85_000_000,
        available: 85_000_000,
        constrained: 34_359_738_368,
      });
      const { memory } = await run('memory');
      expect(memory).not.toHaveProperty('limitBytes');
      expect(memory?.availableBytes).toBe(85_000_000);
      expect(readFileSyncMock).not.toHaveBeenCalled();
    });

    it('omits limitBytes when constrainedMemory() exceeds the host RAM (Node, unlimited cgroup)', async () => {
      // node:24-slim with memory.max = "max" reports 2^64 − 1.
      host({
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
      host({ total: 34_359_738_368, free: 23_150_592, available: 11_859_410_944, constrained: 0 });
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
