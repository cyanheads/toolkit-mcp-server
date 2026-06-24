/**
 * @fileoverview toolkit_check_system — GATED, Node-only host system facts:
 * OS, CPU, memory, load average, or network interfaces. Registered only when
 * TOOLKIT_ENABLE_SYSTEM_INFO=true; absent from tools/list otherwise. STRICTLY
 * READ-ONLY — reads os/process, never mutates host state. Reports the SERVER
 * host (not the client), so it is meaningful only on a local/self-hosted
 * deployment; gated off by default because it discloses host specs and
 * internal interface addresses.
 * @module mcp-server/tools/definitions/check-system.tool
 */

import os from 'node:os';
import process from 'node:process';
import { tool, z } from '@cyanheads/mcp-ts-core';

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
    "Report a facet of the server host's system state, read-only. what selects the facet: os (platform, release, architecture, hostname, uptime, Node version), cpu (model, core count, speed), memory (total/free/used bytes), load (1/5/15-minute load averages, all zero on Windows), or interfaces (non-internal network interfaces with their addresses and families). Exactly one facet object is populated per call, matching what; the others are absent. All values describe the host this server runs on, NOT the calling client — so this is useful only on a local or self-hosted deployment. interfaces and os disclose host topology and version details, which is why this tool is gated off by default.",
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
        nodeVersion: z.string().describe('Node.js runtime version of the server process.'),
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
        totalBytes: z.number().describe('Total physical memory in bytes.'),
        freeBytes: z.number().describe('Free physical memory in bytes.'),
        usedBytes: z.number().describe('Used physical memory in bytes (total − free).'),
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

  handler(input, ctx) {
    ctx.log.info('Check system', { what: input.what });
    switch (input.what) {
      case 'os':
        return {
          what: 'os' as const,
          os: {
            platform: os.platform(),
            release: os.release(),
            arch: os.arch(),
            hostname: os.hostname(),
            uptimeSeconds: Math.round(os.uptime()),
            nodeVersion: process.version,
          },
        };
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
      case 'memory': {
        const total = os.totalmem();
        const free = os.freemem();
        return {
          what: 'memory' as const,
          memory: { totalBytes: total, freeBytes: free, usedBytes: total - free },
        };
      }
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
        `**OS:** ${o.platform} ${o.release} (${o.arch}) | **Host:** ${o.hostname} | **Uptime:** ${o.uptimeSeconds}s | **Node:** ${o.nodeVersion}`,
      );
    }
    if (result.cpu) {
      const c = result.cpu;
      lines.push(`**CPU:** ${c.model} | **Cores:** ${c.cores} | **Speed:** ${c.speedMhz} MHz`);
    }
    if (result.memory) {
      const m = result.memory;
      const gb = (n: number) => (n / 1024 ** 3).toFixed(2);
      lines.push(
        `**Memory:** ${gb(m.usedBytes)} / ${gb(m.totalBytes)} GiB used (${gb(m.freeBytes)} GiB free) — totalBytes ${m.totalBytes}, freeBytes ${m.freeBytes}, usedBytes ${m.usedBytes}`,
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
