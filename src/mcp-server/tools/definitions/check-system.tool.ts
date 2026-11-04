/**
 * @fileoverview toolkit_check_system — GATED, Node-only host system facts:
 * OS, CPU, memory, load average, or network interfaces. Registered only when
 * TOOLKIT_ENABLE_SYSTEM_INFO=true; absent from tools/list otherwise. STRICTLY
 * READ-ONLY — reads os/process, the cgroup memory-usage file under a container
 * limit, and (under Bun on macOS) the `vm_stat` page counters; never mutates
 * host state. Reports the SERVER host (not the client), so it is meaningful
 * only on a local/self-hosted deployment; gated off by default because it
 * discloses host specs and internal interface addresses.
 * @module mcp-server/tools/definitions/check-system.tool
 */

import { type ExecFileException, execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

/** Current memory use of this process's cgroup — v2 first, then the v1 hierarchy. */
const CGROUP_USAGE_FILES = [
  '/sys/fs/cgroup/memory.current',
  '/sys/fs/cgroup/memory/memory.usage_in_bytes',
];

/** The cgroup's current memory use in bytes, or undefined when neither file is readable. */
function readCgroupUsage(): number | undefined {
  for (const path of CGROUP_USAGE_FILES) {
    try {
      return Number(readFileSync(path, 'utf8').trim());
    } catch {
      // Not this cgroup version (or no cgroup at all) — try the next file.
    }
  }
  return;
}

/** macOS page statistics, at a fixed path so no PATH lookup can substitute another binary. */
const VM_STAT_PATH = '/usr/bin/vm_stat';

/** A backstop for a hung `vm_stat`, which normally prints within milliseconds. */
const VM_STAT_TIMEOUT_MS = 5000;

/** The page counts libuv's darwin `uv_get_available_memory()` sums; speculative pages are not among them. */
const VM_STAT_AVAILABLE_COUNTS = [
  /^Pages free: +(\d+)\.$/m,
  /^Pages inactive: +(\d+)\.$/m,
  /^Pages purgeable: +(\d+)\.$/m,
];

/**
 * (free + inactive + purgeable pages) × the page size the `vm_stat` header
 * prints, or undefined when the page size or any of the three counts is missing.
 */
function parseVmStatAvailable(stdout: string): number | undefined {
  const pageSize = /^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)$/m.exec(
    stdout,
  )?.[1];
  if (pageSize === undefined) return;
  let pages = 0;
  for (const pattern of VM_STAT_AVAILABLE_COUNTS) {
    const count = pattern.exec(stdout)?.[1];
    if (count === undefined) return;
    pages += Number(count);
  }
  return pages * Number(pageSize);
}

/** Why `vm_stat` produced no output: it never spawned, hit the timeout, or exited unsuccessfully. */
function describeVmStatFailure(err: ExecFileException): string {
  if (typeof err.code === 'string') return `could not be started (${err.code})`;
  if (err.killed) return `did not finish within ${VM_STAT_TIMEOUT_MS} ms`;
  return `exited with ${err.code == null ? `signal ${err.signal}` : `status ${err.code}`}`;
}

/** The failure the `memory_stats_unavailable` contract entry declares. */
const statsUnavailable = (detail: string, cause?: unknown) =>
  serviceUnavailable(
    `Could not read the host's memory statistics: ${VM_STAT_PATH} ${detail}.`,
    { reason: 'memory_stats_unavailable' },
    { cause },
  );

/**
 * The headroom Node's `process.availableMemory()` reports on macOS — libuv's
 * darwin `uv_get_available_memory()` — computed from `vm_stat`, for Bun, whose
 * `availableMemory()` there is free pages alone. Never falls back to free pages:
 * a spawn that fails or prints no page counts throws `memory_stats_unavailable`,
 * and a cancellation rejects with the caller's abort reason.
 */
async function readVmStatAvailable(signal: AbortSignal): Promise<number> {
  const stdout = await new Promise<string>((resolve, reject) => {
    try {
      execFile(VM_STAT_PATH, [], { timeout: VM_STAT_TIMEOUT_MS, signal }, (err, out) => {
        if (signal.aborted) reject(signal.reason);
        else if (err) reject(statsUnavailable(describeVmStatFailure(err), err));
        else resolve(out);
      });
    } catch (err) {
      // Bun and Node throw a spawn the OS refuses outright (EPERM under a
      // sandbox) from execFile itself, its errno as a string `code`; ENOENT
      // still arrives through the callback.
      reject(statsUnavailable(describeVmStatFailure(err as ExecFileException), err));
    }
  });
  const available = parseVmStatAvailable(stdout);
  if (available === undefined) {
    throw statsUnavailable('printed no page size or no free, inactive, or purgeable page count');
  }
  return available;
}

/** Bun reports `process.release.name` as "node", so only `versions.bun` tells the runtimes apart. */
const isBun = () => process.versions.bun !== undefined;

/**
 * Memory figures for the host and, when one applies, the container limit.
 * `constrainedMemory()` is the limit, but its no-limit value varies: Node reports
 * 0 on a bare host and 2^64 − 1 in an unlimited cgroup, and Bun reports the full
 * physical RAM, so only a value below `totalmem()` counts.
 * `availableMemory()` is the headroom, but Bun's is `os.freemem()`. That ignores
 * the cgroup limit, so under a limit it is clamped to limit − usage. On Linux
 * and Windows it is already the OS available-memory figure; on macOS, where it
 * is free pages alone, the figure comes from `vm_stat` as Node computes it.
 */
async function readMemory(signal: AbortSignal) {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const constrained = process.constrainedMemory();
  const limitBytes = constrained > 0 && constrained < totalBytes ? constrained : undefined;
  const available =
    isBun() && process.platform === 'darwin'
      ? await readVmStatAvailable(signal)
      : process.availableMemory();
  const availableBytes =
    limitBytes === undefined
      ? available
      : Math.min(available, Math.max(0, limitBytes - (readCgroupUsage() ?? 0)));
  return {
    totalBytes,
    freeBytes,
    usedBytes: totalBytes - freeBytes,
    availableBytes,
    ...(limitBytes !== undefined && { limitBytes }),
  };
}

/** The interface record shape, shared by the schema and the handler. */
const InterfaceSchema = z
  .object({
    name: z.string().describe('Interface name, e.g. "en0", "eth0".'),
    address: z.string().describe('IP address bound to the interface.'),
    family: z.string().describe('Address family, "IPv4" or "IPv6".'),
    internal: z
      .boolean()
      .describe(
        'Whether the interface is loopback/internal (always false here — internal ones are excluded).',
      ),
  })
  .describe('A single non-internal network interface.');

export const checkSystemTool = tool('toolkit_check_system', {
  title: 'toolkit-mcp-server: check system',
  description:
    "Report a facet of the server host's system state, read-only. what selects the facet: os (platform, release, architecture, hostname, uptime, and the JavaScript runtime with its version), cpu (model, core count, speed), memory (available headroom and any container limit, plus the raw OS total/free/used bytes), load (1/5/15-minute load averages, all zero on Windows), or interfaces (non-internal network interfaces with their addresses and families). Exactly one facet object is populated per call, matching what; the others are absent. All values describe the host this server runs on, NOT the calling client — so this is useful only on a local or self-hosted deployment. interfaces and os disclose host topology and version details, which is why this tool is gated off by default.",
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: false },
  input: z.object({
    what: z
      .enum(['os', 'cpu', 'memory', 'load', 'interfaces'])
      .describe('Which facet to report: os, cpu, memory, load, or interfaces.'),
  }),
  // Flat object; exactly one facet field is populated per call, keyed by `what`.
  output: z.object({
    what: z
      .enum(['os', 'cpu', 'memory', 'load', 'interfaces'])
      .describe('The facet that was reported.'),
    os: z
      .object({
        platform: z.string().describe('OS platform, e.g. "darwin", "linux".'),
        release: z.string().describe('OS release/kernel version.'),
        arch: z.string().describe('CPU architecture, e.g. "arm64", "x64".'),
        hostname: z.string().describe('Host machine name.'),
        uptimeSeconds: z.number().describe('System uptime in seconds.'),
        runtime: z
          .enum(['bun', 'node'])
          .describe('The JavaScript runtime running the server process: "bun" or "node".'),
        runtimeVersion: z
          .string()
          .describe(
            'Version of that runtime, without a "v" prefix — e.g. "1.4.4" under Bun, "26.13.0" under Node.js.',
          ),
        nodeVersion: z
          .string()
          .describe(
            'The Node.js version the process reports, with a "v" prefix. Under Node.js it is the runtime version; under Bun it is the Node.js API level Bun implements, not the Bun version (runtimeVersion carries that).',
          ),
      })
      .optional()
      .describe('Operating-system facts. Present only for what="os".'),
    cpu: z
      .object({
        model: z.string().describe('CPU model string of the first core.'),
        cores: z.number().describe('Logical core count.'),
        speedMhz: z.number().describe('Reported clock speed of the first core, in MHz.'),
      })
      .optional()
      .describe('CPU facts. Present only for what="cpu".'),
    memory: z
      .object({
        totalBytes: z
          .number()
          .describe(
            "Total physical memory in bytes, as the OS reports it — the host's RAM even inside a container.",
          ),
        freeBytes: z
          .number()
          .describe(
            "Free physical memory in bytes, the raw OS figure. On macOS it counts free pages only, excluding reclaimable inactive and purgeable pages, so it can read near zero on a healthy host; on Linux and Windows it is the OS's available-memory figure, which counts reclaimable cache as free.",
          ),
        usedBytes: z
          .number()
          .describe(
            'totalBytes − freeBytes, the raw OS figure. On macOS it counts reclaimable cache as used, so it overstates real pressure there; availableBytes is the headroom.',
          ),
        availableBytes: z
          .number()
          .describe(
            "Memory still available to this server process for new allocations, in bytes — the headroom figure. On macOS it counts free, inactive, and purgeable pages; on Linux and Windows it is the OS's available-memory figure. Bounded by the container limit minus current usage when limitBytes is present.",
          ),
        limitBytes: z
          .number()
          .optional()
          .describe(
            'The container (cgroup) memory limit on this process, in bytes. Absent when no limit below the host RAM applies.',
          ),
      })
      .optional()
      .describe('Memory facts. Present only for what="memory".'),
    load: z
      .object({
        avg1: z.number().describe('1-minute load average (0 on Windows).'),
        avg5: z.number().describe('5-minute load average (0 on Windows).'),
        avg15: z.number().describe('15-minute load average (0 on Windows).'),
      })
      .optional()
      .describe('Load-average facts. Present only for what="load".'),
    interfaces: z
      .array(InterfaceSchema)
      .optional()
      .describe('Non-internal network interfaces on the host. Present only for what="interfaces".'),
  }),

  errors: [
    {
      reason: 'memory_stats_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'what is memory, the server runs under Bun on macOS, and the host page statistics could not be read because the statistics command failed to start, did not finish in time, exited with a non-zero status, was terminated by a signal, or printed no page counts.',
      recovery:
        'Retry once; if it fails again, treat memory headroom as unknown on this host rather than estimating it, and use the other facets, which do not read these statistics.',
      // readVmStatAvailable raises it; the handler never names the reason.
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Check system', { what: input.what });
    switch (input.what) {
      case 'os': {
        const runtime: 'bun' | 'node' = isBun() ? 'bun' : 'node';
        return {
          what: 'os' as const,
          os: {
            platform: os.platform(),
            release: os.release(),
            arch: os.arch(),
            hostname: os.hostname(),
            uptimeSeconds: Math.round(os.uptime()),
            runtime,
            runtimeVersion: process.versions.bun ?? process.versions.node,
            nodeVersion: process.version,
          },
        };
      }
      case 'cpu': {
        const cpus = os.cpus();
        const first = cpus[0];
        return {
          what: 'cpu' as const,
          cpu: {
            model: first?.model ?? 'unknown',
            cores: cpus.length,
            speedMhz: first?.speed ?? 0,
          },
        };
      }
      case 'memory':
        return { what: 'memory' as const, memory: await readMemory(ctx.signal) };
      case 'load': {
        const [avg1 = 0, avg5 = 0, avg15 = 0] = os.loadavg();
        return { what: 'load' as const, load: { avg1, avg5, avg15 } };
      }
      case 'interfaces': {
        const interfaces: z.infer<typeof InterfaceSchema>[] = [];
        for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
          for (const addr of addrs ?? []) {
            if (addr.internal) continue; // exclude loopback/internal
            interfaces.push({
              name,
              address: addr.address,
              family: String(addr.family),
              internal: addr.internal,
            });
          }
        }
        return { what: 'interfaces' as const, interfaces };
      }
    }
  },

  // Renders whichever facet is present. The linter synthesizes all facets at
  // once; each branch here emits its fields, so every field path is covered.
  format: (result) => {
    const lines: string[] = [`**Facet:** ${result.what}`];
    if (result.os) {
      const o = result.os;
      lines.push(
        `**OS:** ${o.platform} ${o.release} (${o.arch}) | **Host:** ${o.hostname} | **Uptime:** ${o.uptimeSeconds}s | **Runtime:** ${o.runtime} ${o.runtimeVersion} | **Node.js API:** ${o.nodeVersion}`,
      );
    }
    if (result.cpu) {
      const c = result.cpu;
      lines.push(`**CPU:** ${c.model} | **Cores:** ${c.cores} | **Speed:** ${c.speedMhz} MHz`);
    }
    if (result.memory) {
      const m = result.memory;
      const gb = (n: number) => (n / 1024 ** 3).toFixed(2);
      const limit =
        m.limitBytes !== undefined
          ? `container limit ${gb(m.limitBytes)} GiB (limitBytes ${m.limitBytes})`
          : 'no container memory limit';
      lines.push(
        `**Memory available:** ${gb(m.availableBytes)} GiB (availableBytes ${m.availableBytes}) — ${limit}`,
        `**OS memory (raw):** ${gb(m.usedBytes)} / ${gb(m.totalBytes)} GiB used (${gb(m.freeBytes)} GiB free) — totalBytes ${m.totalBytes}, freeBytes ${m.freeBytes}, usedBytes ${m.usedBytes}`,
      );
    }
    if (result.load) {
      const l = result.load;
      lines.push(
        `**Load average:** ${l.avg1.toFixed(2)} (1m, avg1) / ${l.avg5.toFixed(2)} (5m, avg5) / ${l.avg15.toFixed(2)} (15m, avg15)`,
      );
    }
    if (result.interfaces) {
      lines.push(`**Network interfaces** (${result.interfaces.length})`);
      for (const i of result.interfaces) {
        lines.push(`- ${i.name}: ${i.address} (${i.family}, internal=${i.internal})`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
