/**
 * @fileoverview toolkit_check_network — GATED, Node-only network diagnostics:
 * ping, traceroute, TCP connectivity, or host egress-IP detection. Registered
 * only when TOOLKIT_ENABLE_NET_DIAGNOSTICS=true; absent from tools/list
 * otherwise. STRICTLY READ-ONLY — observes reachability, never mutates state.
 * A second request-time gate (TOOLKIT_ALLOW_PRIVATE_NETWORK) governs private
 * targets, blocking the cloud-metadata endpoint and internal-recon vectors.
 * @module mcp-server/tools/definitions/check-network.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNetDiagService } from '@/services/network/net-diag-service.js';
import { NetworkTargetSchema } from '@/services/network/target.js';

export const checkNetworkTool = tool('toolkit_check_network', {
  title: 'toolkit-mcp-server: check network',
  description:
    "Run a read-only network diagnostic from the server host. mode selects the probe: ping (ICMP round-trip), traceroute (the hop path to the target), connectivity (a raw TCP connect to target on port), or public_ip (the host's own egress IP, where target is absent and ignored). target takes an IPv4/IPv6 address or a hostname (resolved server-side) and is required for every mode except public_ip; port is required only for connectivity and is passed separately, never as host:port. count sets ping echo requests and timeoutMs the per-probe deadline. A host that does not respond is reported as reachable:false — a valid result, not an error. ping also reports packets sent, received, and percent lost; connectivity reports an outcome of open, refused (nothing listening on the port), timeout (traffic dropped), or unreachable (no route or another socket error). The populated output fields depend on mode. This tool diagnoses the SERVER's own network, so it is useful only on a local/self-hosted deployment; reaching a private/reserved/internal target additionally requires the operator to enable TOOLKIT_ALLOW_PRIVATE_NETWORK.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
  input: z.object({
    mode: z
      .enum(['ping', 'traceroute', 'connectivity', 'public_ip'])
      .describe(
        'Diagnostic to run: ping, traceroute, connectivity (TCP), or public_ip (host egress IP).',
      ),
    target: NetworkTargetSchema.optional().describe(
      'IPv4/IPv6 address or hostname to probe. Required for ping, traceroute, connectivity; absent/ignored for public_ip.',
    ),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe(
        'TCP port for connectivity mode (e.g. 5432). Required for connectivity; ignored otherwise.',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe('Number of ICMP echo requests for ping mode (1–10).'),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(30000)
      .default(3000)
      .describe('Per-probe deadline in milliseconds for ping and connectivity.'),
  }),
  /**
   * `target` takes an IP or a hostname, so a caller reaches for the narrower
   * word for whichever one it holds — the same three spellings
   * toolkit_geolocate_ip accepts for the same schema.
   */
  inputAliases: { ip: 'target', hostname: 'target', host: 'target' },
  // Flat object; the populated fields depend on mode (see each field's note).
  output: z.object({
    mode: z
      .enum(['ping', 'traceroute', 'connectivity', 'public_ip'])
      .describe('The diagnostic that ran.'),
    target: z.string().optional().describe('The target probed. Absent for public_ip.'),
    reachable: z
      .boolean()
      .optional()
      .describe(
        'Whether the host responded. Present for ping and connectivity; false is a valid down result, not an error.',
      ),
    outcome: z
      .enum(['open', 'refused', 'timeout', 'unreachable'])
      .optional()
      .describe(
        'How the TCP connect ended: open (connected), refused (host answered, nothing listening on the port), timeout (no answer within timeoutMs, traffic likely dropped), or unreachable (no route to the host or another socket error). Present for connectivity.',
      ),
    rttMs: z
      .number()
      .optional()
      .describe(
        'Round-trip time in milliseconds: the average echo time for ping when reachable, or the TCP connect time for connectivity when outcome is open.',
      ),
    sent: z
      .number()
      .optional()
      .describe('Echo requests ping transmitted. Present for ping, reachable or not.'),
    received: z
      .number()
      .optional()
      .describe('Echo replies ping received. Present for ping, reachable or not.'),
    packetLossPercent: z
      .number()
      .optional()
      .describe(
        'Share of echo requests that got no reply, 0–100, one decimal. Present for ping; 100 means no reply at all.',
      ),
    hops: z
      .array(
        z
          .object({
            hop: z.number().describe('Hop number along the path (1 = first router).'),
            address: z
              .string()
              .describe('The hop\'s IP address, or "*" when the hop did not respond.'),
            rttMs: z
              .number()
              .optional()
              .describe('Round-trip time to this hop in milliseconds, when measured.'),
          })
          .describe('A single traceroute hop.'),
      )
      .optional()
      .describe('The traceroute hop path. Present for traceroute mode.'),
    publicIp: z
      .string()
      .optional()
      .describe("The host's egress IP as seen externally. Present for public_ip mode."),
  }),

  errors: [
    {
      reason: 'private_target_blocked',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The target is private/reserved/loopback/link-local and TOOLKIT_ALLOW_PRIVATE_NETWORK is off.',
      recovery:
        'This target is a private/reserved address. Set TOOLKIT_ALLOW_PRIVATE_NETWORK=true to permit local-network diagnostics.',
      // NetDiagService.guardTarget raises it; the handler never names the reason.
      thrownBy: 'service',
    },
    {
      reason: 'unreachable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A hostname target could not be resolved, or the ping/traceroute binary could not run in this environment or exited without a result.',
      recovery:
        'Verify the host resolves and the diagnostic binary is available, or try mode connectivity with a port, which uses raw TCP.',
      // NetDiagService.resolve, .ping, and .traceroute raise it.
      thrownBy: 'service',
    },
    {
      reason: 'missing_target',
      code: JsonRpcErrorCode.ValidationError,
      when: 'mode is ping, traceroute, or connectivity and no target was supplied.',
      recovery:
        'Pass target as an IPv4/IPv6 address or hostname, or use mode public_ip, which takes no target.',
      thrownBy: 'service',
    },
    {
      reason: 'missing_port',
      code: JsonRpcErrorCode.ValidationError,
      when: 'mode is connectivity and no port was supplied.',
      recovery: 'Pass port as a separate number (e.g. 443) — connectivity needs one to connect to.',
      thrownBy: 'service',
    },
  ],

  handler(input, ctx) {
    // Service enforces the request-time private-range gate and carries data.reason.
    return getNetDiagService().run(input, ctx);
  },

  // Renders whichever fields the mode populated. The linter synthesizes all
  // fields at once; every branch below emits its fields, so all paths are covered.
  format: (result) => {
    const lines: string[] = [`**Mode:** ${result.mode}`];
    if (result.publicIp) lines.push(`**Host egress IP:** ${result.publicIp}`);
    if (result.hops) {
      lines.push(`**Traceroute to ${result.target ?? '?'}** (${result.hops.length} hops)`);
      for (const h of result.hops) {
        lines.push(`${h.hop}. ${h.address}${h.rttMs != null ? ` — ${h.rttMs} ms` : ''}`);
      }
    }
    if (result.reachable !== undefined) {
      const reach = result.reachable ? 'reachable' : 'NOT reachable';
      const outcome = result.outcome ? ` (${result.outcome})` : '';
      const rttLabel = result.mode === 'connectivity' ? 'connect' : 'avg';
      const rtt = result.rttMs != null ? ` — ${rttLabel} ${result.rttMs} ms` : '';
      lines.push(`**${result.target ?? '?'}:** ${reach}${outcome}${rtt}`);
    }
    if (result.sent !== undefined) {
      lines.push(
        `**Packets:** ${result.sent} sent, ${result.received ?? '?'} received, ${result.packetLossPercent ?? '?'}% loss`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
