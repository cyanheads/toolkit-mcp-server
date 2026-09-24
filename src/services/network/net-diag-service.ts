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
import { fetchWithTimeout, logger } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { isPrivateOrReservedIp } from './target.js';

const execFileAsync = promisify(execFile);

/** A single traceroute hop. */
export type Hop = { hop: number; address: string; rttMs?: number };

/** Packet counts from a ping summary line, with loss rounded to one decimal. */
type PacketLoss = { sent: number; received: number; packetLossPercent: number };

/** How a TCP connect attempt ended. */
export type ConnectOutcome = 'open' | 'refused' | 'timeout' | 'unreachable';

/** Result of a network diagnostic — discriminated by mode (mirrors the tool output). */
export type NetDiagResult =
  | ({ mode: 'ping'; target: string; reachable: boolean; rttMs?: number } & Partial<PacketLoss>)
  | {
      mode: 'connectivity';
      target: string;
      reachable: boolean;
      outcome: ConnectOutcome;
      rttMs?: number;
    }
  | { mode: 'traceroute'; target: string; hops: Hop[] }
  | { mode: 'public_ip'; publicIp: string };

/** The rejection promisified execFile produces: an exit status or a spawn errno, plus the streams. */
type ExecError = Error & {
  code?: string | number | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
};

/**
 * macOS/BSD split IPv6 into separate `ping6`/`traceroute6` binaries — their
 * `ping`/`traceroute` reject an IPv6 literal as an unknown host. Linux's
 * binaries are unified, and Windows' ping/tracert detect the family from the
 * address, so both keep a single binary.
 */
const usesV6Binary = (resolvedIp: string) =>
  process.platform !== 'win32' && process.platform !== 'linux' && isIP(resolvedIp) === 6;

/**
 * Why a diagnostic binary produced no result: it never spawned (named by its
 * errno), was stopped at the spawn timeout, or exited with output the service
 * could not read as a result (its stderr carried through).
 */
function describeExecFailure(failure: ExecError, spawnTimeoutMs: number): string {
  if (typeof failure.code === 'string') {
    return `could not be started (${failure.code}) — it is missing or not executable in this environment`;
  }
  if (failure.killed) return `did not finish within ${spawnTimeoutMs} ms`;
  const status = typeof failure.code === 'number' ? ` with status ${failure.code}` : '';
  const stderr = failure.stderr?.trim();
  return `exited${status}, and its output could not be interpreted as a result${stderr ? `: ${stderr}` : ''}`;
}

/** The discriminator literal accepted by run() — kept aligned with the tool input enum. */
type NetDiagMode = NetDiagResult['mode'];

export class NetDiagService {
  /**
   * Request-time gate: resolve the target, then reject private/reserved IPs
   * unless TOOLKIT_ALLOW_PRIVATE_NETWORK is set. Returns the resolved IP. This
   * is the single chokepoint every target-bearing mode passes through.
   */
  private async guardTarget(target: string, ctx: Context): Promise<string> {
    const resolvedIp = isIP(target) !== 0 ? target : await this.resolve(target, ctx);
    if (isPrivateOrReservedIp(resolvedIp) && !getServerConfig().allowPrivateNetwork) {
      throw validationError(`${target} (${resolvedIp}) is a private/reserved address.`, {
        reason: 'private_target_blocked',
        ...ctx.recoveryFor('private_target_blocked'),
      });
    }
    return resolvedIp;
  }

  /** DNS-resolve a hostname; an unresolvable host is an upstream-class failure. */
  private async resolve(target: string, ctx: Context): Promise<string> {
    try {
      const { address } = await lookup(target);
      return address;
    } catch {
      throw serviceUnavailable(`Could not resolve "${target}".`, {
        reason: 'unreachable',
        ...ctx.recoveryFor('unreachable'),
      });
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

    // The other three modes require a target, and connectivity a port — both
    // checked before any DNS lookup or probe runs.
    const { target } = input;
    if (!target) {
      throw validationError(`target is required for mode "${input.mode}".`, {
        reason: 'missing_target',
        ...ctx.recoveryFor('missing_target'),
      });
    }
    if (input.mode === 'connectivity') {
      const { port } = input;
      if (port === undefined) {
        throw validationError('port is required for mode "connectivity".', {
          reason: 'missing_port',
          ...ctx.recoveryFor('missing_port'),
        });
      }
      const resolvedIp = await this.guardTarget(target, ctx);
      return this.connectivity(target, resolvedIp, port, input.timeoutMs, ctx);
    }
    const resolvedIp = await this.guardTarget(target, ctx);
    if (input.mode === 'ping')
      return this.ping(target, resolvedIp, input.count, input.timeoutMs, ctx);
    return this.traceroute(target, resolvedIp, ctx);
  }

  /**
   * ICMP ping via the OS binary. A down host is reachable:false, not an error —
   * but only when the binary actually ran and printed its packet-loss summary.
   * A binary that never spawned, or exited without a summary (a usage error, an
   * address it rejects), diagnosed nothing and throws `unreachable`. reachable
   * follows the reply count, not the exit status: Linux iputils given both -c
   * and -w exits 1 whenever fewer than count replies arrive, partial loss
   * included.
   */
  private async ping(
    target: string,
    resolvedIp: string,
    count: number,
    timeoutMs: number,
    ctx: Context,
  ): Promise<NetDiagResult> {
    const deadlineSec = Math.max(1, Math.ceil((timeoutMs * count) / 1000));
    const v6 = usesV6Binary(resolvedIp);
    const binary = v6 ? 'ping6' : 'ping';
    // Four flag sets. BSD/macOS and Linux share -c count and differ on the
    // deadline flag (-t vs -w, both seconds); Windows takes -n count and -w as a
    // PER-REPLY timeout in milliseconds and rejects -c outright, which would
    // exit non-zero and report a live host as down. macOS ping6 has no deadline
    // flag at all (its -t requests Node Information).
    const args =
      process.platform === 'win32'
        ? ['-n', String(count), '-w', String(timeoutMs), resolvedIp]
        : v6
          ? ['-c', String(count), resolvedIp]
          : [
              '-c',
              String(count),
              process.platform === 'linux' ? '-w' : '-t',
              String(deadlineSec),
              resolvedIp,
            ];
    // A backstop for a hung binary, never the normal exit. Echoes go out about
    // 1 s apart on every platform, so a run lasts at least count seconds
    // whatever timeoutMs says (Windows has no overall deadline to cut it short),
    // and macOS ping6 then waits a fixed 10 s for the last reply.
    const spawnTimeoutMs = count * Math.max(timeoutMs, 1000) + (v6 ? 11_000 : 2000);
    let stdout = '';
    let failure: ExecError | undefined;
    try {
      ({ stdout } = await execFileAsync(binary, args, {
        timeout: spawnTimeoutMs,
        signal: ctx.signal,
      }));
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      failure = err as ExecError;
      // A binary that never spawned carries empty streams, so it has no summary.
      stdout = failure.stdout ?? '';
    }
    const loss = this.parsePacketLoss(stdout);
    if (failure && !loss) {
      throw serviceUnavailable(
        `${binary} ${describeExecFailure(failure, spawnTimeoutMs)} (target ${target}).`,
        { reason: 'unreachable', ...ctx.recoveryFor('unreachable') },
        { cause: failure },
      );
    }
    const reachable = loss === undefined || loss.received > 0;
    const rttMs = reachable ? this.parsePingRtt(stdout) : undefined;
    ctx.log.info('Ping', { target, reachable, rttMs, ...loss });
    return { mode: 'ping', target, reachable, ...(rttMs != null && { rttMs }), ...loss };
  }

  /**
   * Parse sent/received counts from a ping summary line. macOS/BSD print
   * "N packets transmitted, M packets received"; Linux iputils drops the second
   * "packets"; Windows prints "Sent = N, Received = M". Loss is computed from
   * the counts, since each platform rounds its printed percentage differently.
   */
  private parsePacketLoss(stdout: string): PacketLoss | undefined {
    const counts =
      stdout.match(/(\d+) packets transmitted, (\d+)(?: packets)? received/) ??
      stdout.match(/Sent = (\d+), Received = (\d+)/);
    if (!counts?.[1] || !counts[2]) return;
    const sent = Number.parseInt(counts[1], 10);
    const received = Number.parseInt(counts[2], 10);
    if (sent === 0) return;
    const packetLossPercent = Math.round(((sent - received) / sent) * 1000) / 10;
    return { sent, received, packetLossPercent };
  }

  /** Parse the average RTT (ms) from ping summary output (BSD, Linux, or Windows). */
  private parsePingRtt(stdout: string): number | undefined {
    // "round-trip min/avg/max/stddev = 0.05/0.07/0.09/0.01 ms" or "rtt min/avg/max/mdev = ..."
    const summary = stdout.match(/=\s*[\d.]+\/([\d.]+)\//);
    if (summary?.[1]) return Number.parseFloat(summary[1]);
    // Windows reports the same average as a labelled line: "Average = 11ms".
    const windowsAverage = stdout.match(/Average\s*=\s*([\d.]+)\s*ms/i);
    if (windowsAverage?.[1]) return Number.parseFloat(windowsAverage[1]);
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
    // Windows ships tracert, not traceroute, with its own flags: -d numeric,
    // -h 30 max hops, -w per-probe wait in ms (unix -w is seconds). Unix:
    // -n numeric, -w 1s per-probe wait, -q 1 one probe per hop, -m 30 max hops;
    // macOS/BSD take the same flags on traceroute6 for an IPv6 target.
    const [binary, args] =
      process.platform === 'win32'
        ? (['tracert', ['-d', '-h', '30', '-w', '1000', resolvedIp]] as const)
        : ([
            usesV6Binary(resolvedIp) ? 'traceroute6' : 'traceroute',
            ['-n', '-w', '1', '-q', '1', '-m', '30', resolvedIp],
          ] as const);
    const spawnTimeoutMs = 60_000;
    try {
      const { stdout } = await execFileAsync(binary, [...args], {
        timeout: spawnTimeoutMs,
        signal: ctx.signal,
      });
      const hops = this.parseTraceroute(stdout);
      ctx.log.info('Traceroute', { target, hopCount: hops.length });
      return { mode: 'traceroute', target, hops };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      throw serviceUnavailable(
        `${binary} ${describeExecFailure(err as ExecError, spawnTimeoutMs)} (target ${target}).`,
        { reason: 'unreachable', ...ctx.recoveryFor('unreachable') },
        { cause: err },
      );
    }
  }

  /**
   * Parse hop number, address, and first RTT from traceroute or tracert output.
   * The two formats order the columns differently (unix puts the address first,
   * tracert puts it after the RTT columns), so the address is located by shape
   * rather than by position. The IPv6 alternative requires at least two colons:
   * a looser hex-run pattern reads prose — tracert's "Request timed out." — as
   * an address.
   */
  private parseTraceroute(stdout: string): Hop[] {
    const hops: Hop[] = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m?.[1]) continue;
      const hopNum = Number.parseInt(m[1], 10);
      const rest = m[2] ?? '';
      const ipMatch = rest.match(
        /(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,})/,
      );
      const rttMatch = rest.match(/([\d.]+)\s*ms/);
      const hop: Hop = { hop: hopNum, address: ipMatch?.[1] ?? '*' };
      if (rttMatch?.[1]) hop.rttMs = Number.parseFloat(rttMatch[1]);
      hops.push(hop);
    }
    return hops;
  }

  /**
   * Raw TCP connect probe — the most portable reachability mode. The outcome
   * separates a closed port (refused) from traffic that is dropped (timeout) or
   * never routed (unreachable — every other socket error). rttMs is the time
   * from connect() to the connect event, so it exists only when the port opened.
   */
  private connectivity(
    target: string,
    resolvedIp: string,
    port: number,
    timeoutMs: number,
    ctx: Context,
  ): Promise<NetDiagResult> {
    return new Promise<NetDiagResult>((resolve, reject) => {
      const startedAt = performance.now();
      const socket = connect({ host: resolvedIp, port });
      let settled = false;
      const settle = () => {
        if (settled) return false;
        settled = true;
        socket.destroy();
        return true;
      };
      const done = (outcome: ConnectOutcome) => {
        if (!settle()) return;
        const rttMs =
          outcome === 'open' ? Math.round((performance.now() - startedAt) * 100) / 100 : undefined;
        ctx.log.info('Connectivity', { target, port, outcome, rttMs });
        resolve({
          mode: 'connectivity',
          target,
          reachable: outcome === 'open',
          outcome,
          ...(rttMs !== undefined && { rttMs }),
        });
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done('open'));
      socket.once('timeout', () => done('timeout'));
      socket.once('error', (err: NodeJS.ErrnoException) =>
        done(err.code === 'ECONNREFUSED' ? 'refused' : 'unreachable'),
      );
      // A caller cancellation is not a connect outcome — it bubbles as itself.
      ctx.signal.addEventListener('abort', () => settle() && reject(ctx.signal.reason), {
        once: true,
      });
    });
  }

  /**
   * Detect the host's egress IP via an external echo endpoint. A provider
   * failure is re-thrown sanitized: the framework fetch error carries the echo
   * URL, HTTP status, and up to 500 bytes of the upstream response body in its
   * `data`, none of which belongs on the wire. The original is preserved as
   * `cause` for server-side logs and telemetry only, and goes to the process
   * logger rather than `ctx.log` — the latter is dual-sink and mirrors every
   * call to the client as `notifications/message`, which would put the echo URL
   * and status back on the wire the sanitizing re-throw exists to keep clean.
   */
  private async publicIp(ctx: Context): Promise<NetDiagResult> {
    let body: { ip?: string };
    try {
      const response = await fetchWithTimeout('https://api.ipify.org?format=json', 8000, ctx, {
        signal: ctx.signal,
      });
      body = (await response.json()) as { ip?: string };
    } catch (err) {
      // Caller cancellation isn't a provider failure — let it bubble unchanged.
      if (ctx.signal.aborted) throw err;
      logger.error(
        'Egress-IP echo request failed',
        err instanceof Error ? err : new Error(String(err)),
        ctx,
      );
      throw serviceUnavailable('Egress-IP echo is unavailable. Try again shortly.', undefined, {
        cause: err,
      });
    }
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
