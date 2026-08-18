/**
 * @fileoverview NetDiagService — Node-only network diagnostics for the gated
 * toolkit_check_network tool. Centralizes the request-time private-range guard
 * (the SECOND tier of the gate; config-flag registration is the first) so no
 * mode can bypass it. STRICTLY READ-ONLY: it observes reachability via ping,
 * traceroute, a TCP connect probe, and an egress-IP echo — it never mutates any
 * system, network, or process state.
 * @module services/network/net-diag-service
 */

import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { connect, isIP } from 'node:net';
import process from 'node:process';
import { promisify } from 'node:util';
import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { isPrivateOrReservedIp } from './target.js';

const execFileAsync = promisify(execFile);

/** A single traceroute hop. */
export type Hop = { hop: number; address: string; rttMs?: number };

/** Result of a network diagnostic — discriminated by mode (mirrors the tool output). */
export type NetDiagResult =
  | { mode: 'ping'; target: string; reachable: boolean; rttMs?: number }
  | { mode: 'connectivity'; target: string; reachable: boolean }
  | { mode: 'traceroute'; target: string; hops: Hop[] }
  | { mode: 'public_ip'; publicIp: string };

/** The discriminator literal accepted by run() — kept aligned with the tool input enum. */
type NetDiagMode = NetDiagResult['mode'];

export class NetDiagService {
  /**
   * Request-time gate: resolve the target, then reject private/reserved IPs
   * unless TOOLKIT_ALLOW_PRIVATE_NETWORK is set. Returns the resolved IP. This
   * is the single chokepoint every target-bearing mode passes through.
   */
  private async guardTarget(target: string, ctx: Context): Promise<string> {
    const resolvedIp = isIP(target) !== 0 ? target : await this.resolve(target);
    if (isPrivateOrReservedIp(resolvedIp) && !getServerConfig().allowPrivateNetwork) {
      throw validationError(`${target} (${resolvedIp}) is a private/reserved address.`, {
        reason: 'private_target_blocked',
        ...ctx.recoveryFor('private_target_blocked'),
      });
    }
    return resolvedIp;
  }

  /** DNS-resolve a hostname; an unresolvable host is an upstream-class failure. */
  private async resolve(target: string): Promise<string> {
    try {
      const { address } = await lookup(target);
      return address;
    } catch {
      throw serviceUnavailable(`Could not resolve "${target}".`, { reason: 'unreachable' });
    }
  }

  /** Dispatch to the requested diagnostic mode. */
  async run(
    input: {
      mode: NetDiagMode;
      target?: string | undefined;
      port?: number | undefined;
      count: number;
      timeoutMs: number;
    },
    ctx: Context,
  ): Promise<NetDiagResult> {
    if (input.mode === 'public_ip') return this.publicIp(ctx);

    // The other three modes require a target.
    if (!input.target) {
      throw validationError(`target is required for mode "${input.mode}".`);
    }
    const resolvedIp = await this.guardTarget(input.target, ctx);

    if (input.mode === 'ping')
      return this.ping(input.target, resolvedIp, input.count, input.timeoutMs, ctx);
    if (input.mode === 'traceroute') return this.traceroute(input.target, resolvedIp, ctx);
    return this.connectivity(input.target, resolvedIp, input.port, input.timeoutMs, ctx);
  }

  /** ICMP ping via the OS binary. A down host is reachable:false, not an error. */
  private async ping(
    target: string,
    resolvedIp: string,
    count: number,
    timeoutMs: number,
    ctx: Context,
  ): Promise<NetDiagResult> {
    const deadlineSec = Math.max(1, Math.ceil((timeoutMs * count) / 1000));
    // -c count is common to BSD/macOS and Linux ping. macOS: -t deadline(s); Linux: -w deadline(s).
    const timeoutFlag =
      process.platform === 'linux' ? ['-w', String(deadlineSec)] : ['-t', String(deadlineSec)];
    try {
      const { stdout } = await execFileAsync(
        'ping',
        ['-c', String(count), ...timeoutFlag, resolvedIp],
        {
          timeout: timeoutMs * count + 2000,
          signal: ctx.signal,
        },
      );
      const rttMs = this.parsePingRtt(stdout);
      ctx.log.info('Ping', { target, reachable: true, rttMs });
      return { mode: 'ping', target, reachable: true, ...(rttMs != null && { rttMs }) };
    } catch {
      // Non-zero exit = host did not respond. That's a valid diagnostic result.
      ctx.log.info('Ping', { target, reachable: false });
      return { mode: 'ping', target, reachable: false };
    }
  }

  /** Parse the average RTT (ms) from ping summary output (BSD or Linux format). */
  private parsePingRtt(stdout: string): number | undefined {
    // "round-trip min/avg/max/stddev = 0.05/0.07/0.09/0.01 ms" or "rtt min/avg/max/mdev = ..."
    const summary = stdout.match(/=\s*[\d.]+\/([\d.]+)\//);
    if (summary?.[1]) return Number.parseFloat(summary[1]);
    // Fall back to the first per-packet "time=NN ms".
    const perPacket = stdout.match(/time[=<]([\d.]+)\s*ms/i);
    return perPacket?.[1] ? Number.parseFloat(perPacket[1]) : undefined;
  }

  /** Traceroute via the OS binary. Reachability is not the metric here — hops are. */
  private async traceroute(
    target: string,
    resolvedIp: string,
    ctx: Context,
  ): Promise<NetDiagResult> {
    try {
      // -n numeric (no reverse DNS), -w 1s per-probe wait, -q 1 one probe per hop, -m 30 max hops.
      const { stdout } = await execFileAsync(
        'traceroute',
        ['-n', '-w', '1', '-q', '1', '-m', '30', resolvedIp],
        {
          timeout: 60_000,
          signal: ctx.signal,
        },
      );
      const hops = this.parseTraceroute(stdout);
      ctx.log.info('Traceroute', { target, hopCount: hops.length });
      return { mode: 'traceroute', target, hops };
    } catch (err) {
      throw serviceUnavailable(
        `traceroute failed for ${target} — the binary may be unavailable or blocked in this environment.`,
        { reason: 'unreachable' },
        { cause: err },
      );
    }
  }

  /** Parse hop number, address, and first RTT from traceroute output. */
  private parseTraceroute(stdout: string): Hop[] {
    const hops: Hop[] = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m?.[1]) continue;
      const hopNum = Number.parseInt(m[1], 10);
      const rest = m[2] ?? '';
      const ipMatch = rest.match(/(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,})/);
      const rttMatch = rest.match(/([\d.]+)\s*ms/);
      const hop: Hop = { hop: hopNum, address: ipMatch?.[1] ?? '*' };
      if (rttMatch?.[1]) hop.rttMs = Number.parseFloat(rttMatch[1]);
      hops.push(hop);
    }
    return hops;
  }

  /** Raw TCP connect probe — the most portable reachability mode. */
  private connectivity(
    target: string,
    resolvedIp: string,
    port: number | undefined,
    timeoutMs: number,
    ctx: Context,
  ): Promise<NetDiagResult> {
    if (port === undefined) {
      throw validationError('port is required for mode "connectivity".');
    }
    return new Promise<NetDiagResult>((resolve) => {
      const socket = connect({ host: resolvedIp, port });
      let settled = false;
      const done = (reachable: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        ctx.log.info('Connectivity', { target, port, reachable });
        resolve({ mode: 'connectivity', target, reachable });
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      ctx.signal.addEventListener('abort', () => done(false), { once: true });
    });
  }

  /** Detect the host's egress IP via an external echo endpoint. */
  private async publicIp(ctx: Context): Promise<NetDiagResult> {
    const response = await fetchWithTimeout('https://api.ipify.org?format=json', 8000, ctx, {
      signal: ctx.signal,
    });
    const body = (await response.json()) as { ip?: string };
    if (!body.ip) {
      throw serviceUnavailable('Egress-IP echo returned no address.');
    }
    ctx.log.info('Public IP', { publicIp: body.ip });
    return { mode: 'public_ip', publicIp: body.ip };
  }
}

// --- Init/accessor pattern ---

let _service: NetDiagService | undefined;

/** Initialize the NetDiagService singleton — call from createApp setup() when net-diag is enabled. */
export function initNetDiagService(): void {
  _service = new NetDiagService();
}

/** Access the NetDiagService singleton; throws if init was skipped. */
export function getNetDiagService(): NetDiagService {
  if (!_service) {
    throw new Error('NetDiagService not initialized — call initNetDiagService() in setup()');
  }
  return _service;
}
