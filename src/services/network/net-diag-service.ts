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

/** An IP address family, as `net.isIP()` numbers it. */
export type AddressFamily = 4 | 6;

/**
 * Result of a network diagnostic — discriminated by mode (mirrors the tool
 * output). `resolvedIp` is the address whose result is reported.
 */
export type NetDiagResult =
  | ({
      mode: 'ping';
      target: string;
      resolvedIp: string;
      reachable: boolean;
      rttMs?: number;
    } & Partial<PacketLoss>)
  | {
      mode: 'connectivity';
      target: string;
      resolvedIp: string;
      reachable: boolean;
      outcome: ConnectOutcome;
      rttMs?: number;
    }
  | { mode: 'traceroute'; target: string; resolvedIp: string; hops: Hop[] }
  | { mode: 'public_ip'; publicIp: string };

/** The addresses a target may be probed at, in attempt order — never empty. */
type ProbeAddresses = readonly [string, ...string[]];

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

/**
 * Where a failed probe ran: the target alone when it is the address, otherwise
 * the address too, and how far down a hostname's list the probe got.
 */
function describeProbedAddress(
  target: string,
  address: string,
  tried: number,
  total: number,
): string {
  if (address === target) return `target ${target}`;
  const progress = total > 1 ? `, ${tried} of ${total} addresses tried` : '';
  return `target ${target}, address ${address}${progress}`;
}

/**
 * Order addresses for probing: alternate families, leading with the family of
 * the first address and keeping the resolver's order within each family
 * (RFC 8305 §4). A host whose first-answered family has no route reaches the
 * other family on the second attempt, not after every address of the first.
 */
function interleaveFamilies(addresses: readonly string[]): string[] {
  const leadFamily = isIP(addresses[0] ?? '');
  const lead = addresses.filter((address) => isIP(address) === leadFamily);
  const other = addresses.filter((address) => isIP(address) !== leadFamily);
  return Array.from({ length: Math.max(lead.length, other.length) }, (_, i) => [lead[i], other[i]])
    .flat()
    .filter((address) => address !== undefined);
}

/** "1 private/reserved address", "2 private/reserved IPv6 addresses". */
const countAddresses = (count: number, label: string) =>
  `${count} ${label}address${count === 1 ? '' : 'es'}`;

/**
 * The resolved addresses an error message may name. With private targets
 * allowed, all of them; otherwise the public ones, and the private/reserved
 * ones only counted, since the server's resolver can return private answers
 * the caller cannot see.
 */
function describeResolved(addresses: readonly string[]): string {
  if (getServerConfig().allowPrivateNetwork) return addresses.join(', ');
  const listed = addresses.filter((address) => !isPrivateOrReservedIp(address));
  const hidden = addresses.length - listed.length;
  if (hidden === 0) return listed.join(', ');
  const counted = countAddresses(hidden, 'private/reserved ');
  return listed.length === 0 ? counted : `${listed.join(', ')} and ${counted}`;
}

/** A run of a diagnostic binary that produced no result, and how many addresses had been tried. */
type FailedRun = {
  address: string;
  binary: string;
  failure: ExecError;
  timeoutMs: number;
  tried: number;
};

/** The discriminator literal accepted by run() — kept aligned with the tool input enum. */
type NetDiagMode = NetDiagResult['mode'];

export class NetDiagService {
  /**
   * Request-time gate and the single chokepoint every target-bearing mode
   * passes through. Resolves a hostname once to every address it has (an IP
   * literal stands for itself), keeps the requested family, then drops
   * private/reserved addresses unless TOOLKIT_ALLOW_PRIVATE_NETWORK is set.
   * Returns what remains in attempt order. Probes are handed these addresses,
   * never the hostname, so nothing re-resolves past the gate. While private
   * targets are refused, no message names a private/reserved address the
   * resolver returned; an IP literal is the caller's own and is echoed.
   */
  private async guardTarget(
    target: string,
    family: AddressFamily | undefined,
    ctx: Context,
  ): Promise<ProbeAddresses> {
    const literal = isIP(target) !== 0;
    const resolved = literal ? [target] : await this.resolve(target, ctx);
    // Filtered here, never passed to lookup: Node on macOS answers { family: 6 }
    // for an IPv4-only name with an IPv4-mapped ::ffff: address.
    const inFamily = family ? resolved.filter((address) => isIP(address) === family) : resolved;
    if (family && inFamily.length === 0) {
      throw validationError(
        literal
          ? `${target} is not an IPv${family} address.`
          : `${target} has no IPv${family} address; it resolves to ${describeResolved(resolved)}.`,
        { reason: 'family_mismatch' },
      );
    }
    const eligible = getServerConfig().allowPrivateNetwork
      ? inFamily
      : inFamily.filter((address) => !isPrivateOrReservedIp(address));
    const [first, ...rest] = interleaveFamilies(eligible);
    if (first === undefined) {
      // Reached only with private targets refused: every in-family address is private.
      const label = family ? `IPv${family} ` : '';
      throw validationError(
        literal
          ? `${target} is a private/reserved address.`
          : `${target} has no public ${label}address; its ${countAddresses(inFamily.length, label)} ${inFamily.length === 1 ? 'is' : 'are'} private/reserved.`,
        { reason: 'private_target_blocked' },
      );
    }
    return [first, ...rest];
  }

  /**
   * DNS-resolve a hostname to every address it has; an unresolvable host is an
   * upstream-class failure. `lookup` takes no signal, so a caller cancellation
   * rejects at once and the pending query is left to finish unread.
   */
  private async resolve(target: string, ctx: Context): Promise<string[]> {
    ctx.signal.throwIfAborted();
    try {
      const answers = await new Promise<{ address: string }[]>((resolve, reject) => {
        const abort = () => reject(ctx.signal.reason);
        ctx.signal.addEventListener('abort', abort, { once: true });
        void lookup(target, { all: true })
          .then(resolve, reject)
          .finally(() => ctx.signal.removeEventListener('abort', abort));
      });
      return answers.map(({ address }) => address);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
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
      family?: AddressFamily | undefined;
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
      });
    }
    if (input.mode === 'connectivity') {
      const { port } = input;
      if (port === undefined) {
        throw validationError('port is required for mode "connectivity".', {
          reason: 'missing_port',
        });
      }
      const addresses = await this.guardTarget(target, input.family, ctx);
      return this.connectivity(target, addresses, port, input.timeoutMs, ctx);
    }
    const addresses = await this.guardTarget(target, input.family, ctx);
    if (input.mode === 'ping') {
      return this.ping(target, addresses, input.count, input.timeoutMs, ctx);
    }
    return this.traceroute(target, addresses, ctx);
  }

  /**
   * Run a diagnostic binary against each address in turn until one run
   * produces a result. A run that produced none — it could not start, or
   * exited without readable output (no route, a rejected address) — moves on
   * to the next address. The spawn-timeout kill, a cancellation, the last
   * address, or the shared deadline ends the probe: every run spends one
   * budget, the longest backstop any address would get on its own, so a
   * hostname costs no more wall time than its slowest single address.
   */
  private async runEach(
    target: string,
    addresses: ProbeAddresses,
    command: (address: string) => { binary: string; args: string[]; backstopMs: number },
    hasResult: (stdout: string) => boolean,
    ctx: Context,
  ): Promise<{ address: string; stdout: string }> {
    const commands = addresses.map((address) => ({ address, ...command(address) }));
    const deadline = performance.now() + Math.max(...commands.map((c) => c.backstopMs));
    let failed: FailedRun | undefined;
    for (const [index, { address, binary, args, backstopMs }] of commands.entries()) {
      // The first run gets its full backstop, exactly as a single address would.
      const timeoutMs =
        index === 0 ? backstopMs : Math.min(backstopMs, Math.ceil(deadline - performance.now()));
      if (timeoutMs <= 0) break;
      try {
        const { stdout } = await execFileAsync(binary, args, {
          timeout: timeoutMs,
          signal: ctx.signal,
        });
        return { address, stdout };
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        const failure = err as ExecError;
        // A binary that never spawned carries empty streams, so it has no result.
        const stdout = failure.stdout ?? '';
        if (hasResult(stdout)) return { address, stdout };
        failed = { address, binary, failure, timeoutMs, tried: index + 1 };
        if (failure.killed) break;
      }
    }
    // Always set: the first run starts on a positive backstop and either returns or fails.
    const { address, binary, failure, timeoutMs, tried } = failed as FailedRun;
    throw serviceUnavailable(
      `${binary} ${describeExecFailure(failure, timeoutMs)} (${describeProbedAddress(target, address, tried, addresses.length)}).`,
      { reason: 'unreachable' },
      { cause: failure },
    );
  }

  /**
   * ICMP ping via the OS binary. A down host is reachable:false, not an error —
   * but only when the binary actually ran and printed its packet-loss summary.
   * A binary that never spawned, or exited without a summary (a usage error, an
   * address it rejects), diagnosed nothing for that address; when every address
   * ends that way the probe throws `unreachable`. reachable follows the reply
   * count, not the exit status: Linux iputils given both -c and -w exits 1
   * whenever fewer than count replies arrive, partial loss included.
   */
  private async ping(
    target: string,
    addresses: ProbeAddresses,
    count: number,
    timeoutMs: number,
    ctx: Context,
  ): Promise<NetDiagResult> {
    const deadlineSec = Math.max(1, Math.ceil((timeoutMs * count) / 1000));
    const { address, stdout } = await this.runEach(
      target,
      addresses,
      (address) => {
        const v6 = usesV6Binary(address);
        // Four flag sets. BSD/macOS and Linux share -c count and differ on the
        // deadline flag (-t vs -w, both seconds); Windows takes -n count and -w
        // as a PER-REPLY timeout in milliseconds and rejects -c outright, which
        // would exit non-zero and report a live host as down. macOS ping6 has no
        // deadline flag at all (its -t requests Node Information).
        const args =
          process.platform === 'win32'
            ? ['-n', String(count), '-w', String(timeoutMs), address]
            : v6
              ? ['-c', String(count), address]
              : [
                  '-c',
                  String(count),
                  process.platform === 'linux' ? '-w' : '-t',
                  String(deadlineSec),
                  address,
                ];
        // A backstop for a hung binary, never the normal exit. Echoes go out
        // about 1 s apart on every platform, so a run lasts at least count
        // seconds whatever timeoutMs says (Windows has no overall deadline to
        // cut it short), and macOS ping6 then waits a fixed 10 s for the last
        // reply.
        const backstopMs = count * Math.max(timeoutMs, 1000) + (v6 ? 11_000 : 2000);
        return { binary: v6 ? 'ping6' : 'ping', args, backstopMs };
      },
      (output) => this.parsePacketLoss(output) !== undefined,
      ctx,
    );
    const loss = this.parsePacketLoss(stdout);
    const reachable = loss === undefined || loss.received > 0;
    const rttMs = reachable ? this.parsePingRtt(stdout) : undefined;
    ctx.log.info('Ping', { target, resolvedIp: address, reachable, rttMs, ...loss });
    return {
      mode: 'ping',
      target,
      resolvedIp: address,
      reachable,
      ...(rttMs != null && { rttMs }),
      ...loss,
    };
  }

  /**
   * Parse sent/received counts from a ping summary line. macOS/BSD print
   * "N packets transmitted, M packets received"; Linux iputils drops the second
   * "packets"; Windows prints "Sent = N, Received = M", but its received count
   * includes ICMP errors. Count timed echo reply lines on Windows instead.
   * Loss is computed from the counts, since platforms round differently.
   */
  private parsePacketLoss(stdout: string): PacketLoss | undefined {
    const counts =
      stdout.match(/(\d+) packets transmitted, (\d+)(?: packets)? received/) ??
      stdout.match(/Sent = (\d+), Received = (\d+)/);
    if (!counts?.[1] || !counts[2]) return;
    const sent = Number.parseInt(counts[1], 10);
    const received =
      process.platform === 'win32'
        ? [...stdout.matchAll(/^\s*Reply from [^\r\n]+:\s*[^\r\n]*\btime[=<]\s*[\d.]+\s*ms\b/gim)]
            .length
        : Number.parseInt(counts[2], 10);
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

  /**
   * Traceroute via the OS binary. Reachability is not the metric here — hops
   * are. Only a clean exit is a result; any failed run moves on to the next
   * address.
   */
  private async traceroute(
    target: string,
    addresses: ProbeAddresses,
    ctx: Context,
  ): Promise<NetDiagResult> {
    const { address, stdout } = await this.runEach(
      target,
      addresses,
      // Windows ships tracert, not traceroute, with its own flags: -d numeric,
      // -h 30 max hops, -w per-probe wait in ms (unix -w is seconds). Unix:
      // -n numeric, -w 1s per-probe wait, -q 1 one probe per hop, -m 30 max
      // hops; macOS/BSD take the same flags on traceroute6 for an IPv6 target.
      (address) => ({
        ...(process.platform === 'win32'
          ? { binary: 'tracert', args: ['-d', '-h', '30', '-w', '1000', address] }
          : {
              binary: usesV6Binary(address) ? 'traceroute6' : 'traceroute',
              args: ['-n', '-w', '1', '-q', '1', '-m', '30', address],
            }),
        backstopMs: 60_000,
      }),
      () => false,
      ctx,
    );
    const hops = this.parseTraceroute(stdout);
    ctx.log.info('Traceroute', { target, resolvedIp: address, hopCount: hops.length });
    return { mode: 'traceroute', target, resolvedIp: address, hops };
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
   * Raw TCP connect probe — the most portable reachability mode. Tries each
   * address in turn until one opens; any other outcome moves on, `refused`
   * included, since Bun reports a connect with no route as ECONNREFUSED.
   * timeoutMs is one budget for the whole probe: each attempt runs on what
   * remains, so an attempt that times out spent it and is the last one tried.
   * When none opens, the last attempt's outcome and address are reported.
   */
  private async connectivity(
    target: string,
    [first, ...rest]: ProbeAddresses,
    port: number,
    timeoutMs: number,
    ctx: Context,
  ): Promise<NetDiagResult> {
    const deadline = performance.now() + timeoutMs;
    let attempt = await this.connectOnce(first, port, timeoutMs, ctx);
    let tried = 1;
    for (const address of rest) {
      const remainingMs = Math.ceil(deadline - performance.now());
      if (attempt.outcome === 'open' || attempt.outcome === 'timeout' || remainingMs <= 0) break;
      attempt = await this.connectOnce(address, port, remainingMs, ctx);
      tried++;
    }
    const { address, outcome, rttMs } = attempt;
    ctx.log.info('Connectivity', { target, resolvedIp: address, port, outcome, rttMs, tried });
    return {
      mode: 'connectivity',
      target,
      resolvedIp: address,
      reachable: outcome === 'open',
      outcome,
      ...(rttMs !== undefined && { rttMs }),
    };
  }

  /**
   * One TCP connect attempt. The outcome separates a closed port (refused) from
   * traffic that is dropped (timeout) or never routed (unreachable — every
   * other socket error). rttMs is the time from connect() to the connect event,
   * so it exists only when the port opened.
   */
  private connectOnce(
    address: string,
    port: number,
    timeoutMs: number,
    ctx: Context,
  ): Promise<{ address: string; outcome: ConnectOutcome; rttMs?: number }> {
    return new Promise((resolve, reject) => {
      // A cancellation that already fired its abort event (during DNS
      // resolution, or as the previous attempt settled) never reaches the
      // listener below.
      ctx.signal.throwIfAborted();
      const startedAt = performance.now();
      const socket = connect({ host: address, port });
      let settled = false;
      const settle = () => {
        if (settled) return false;
        settled = true;
        socket.destroy();
        ctx.signal.removeEventListener('abort', onAbort);
        return true;
      };
      // A caller cancellation is not a connect outcome — it bubbles as itself.
      const onAbort = () => settle() && reject(ctx.signal.reason);
      const done = (outcome: ConnectOutcome) => {
        if (!settle()) return;
        resolve({
          address,
          outcome,
          ...(outcome === 'open' && {
            rttMs: Math.round((performance.now() - startedAt) * 100) / 100,
          }),
        });
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done('open'));
      socket.once('timeout', () => done('timeout'));
      socket.once('error', (err: NodeJS.ErrnoException) =>
        done(err.code === 'ECONNREFUSED' ? 'refused' : 'unreachable'),
      );
      ctx.signal.addEventListener('abort', onAbort, { once: true });
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
