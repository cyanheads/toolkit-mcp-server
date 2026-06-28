/**
 * @fileoverview Tests for toolkit_check_network at the TOOL layer — error
 * contracts and validation at the handler boundary, plus the diagnostic-gate
 * behavior surfaced through the tool. No live ping/traceroute/DNS: the
 * private-range gate and the required-field validators all fire BEFORE any probe
 * runs, and public_ip is exercised with a stubbed `fetch`. The one live touch is
 * a loopback TCP probe to a closed port (gate-on path), which resolves
 * reachable:false locally without leaving the host.
 * @module tests/tools/check-network.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { checkNetworkTool } from '@/mcp-server/tools/definitions/check-network.tool.js';
import { initNetDiagService } from '@/services/network/net-diag-service.js';

const run = (args: unknown) =>
  checkNetworkTool.handler(
    checkNetworkTool.input.parse(args),
    createMockContext({ errors: checkNetworkTool.errors }),
  );

describe('toolkit_check_network — gate + validation', () => {
  beforeEach(() => {
    resetServerConfig();
    initNetDiagService();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetServerConfig();
  });

  it('blocks the cloud-metadata endpoint when ALLOW_PRIVATE_NETWORK is off', async () => {
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'false');
    resetServerConfig();
    initNetDiagService();
    await expect(
      run({ mode: 'connectivity', target: '169.254.169.254', port: 80 }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'private_target_blocked' },
    });
  });

  it('blocks an RFC-1918 target for ping when the gate is off', async () => {
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'false');
    resetServerConfig();
    initNetDiagService();
    await expect(run({ mode: 'ping', target: '10.0.0.1' })).rejects.toMatchObject({
      data: { reason: 'private_target_blocked' },
    });
  });

  it('blocks a TEST-NET (IANA documentation) target when the gate is off', async () => {
    // TEST-NET-3 (203.0.113.0/24) classifies as reserved, so the gate rejects it
    // like any other private/reserved target when ALLOW_PRIVATE_NETWORK is off.
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'false');
    resetServerConfig();
    initNetDiagService();
    await expect(run({ mode: 'ping', target: '203.0.113.7' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'private_target_blocked' },
    });
  });

  it('rejects a missing target for a target-bearing mode (before any probe)', async () => {
    await expect(run({ mode: 'ping' })).rejects.toThrow(/target is required/);
  });

  it('rejects connectivity without a port (before opening a socket)', async () => {
    // Gate-on so a raw IP passes guardTarget synchronously (no DNS) — 203.0.113.7
    // is now TEST-NET reserved but ALLOW_PRIVATE_NETWORK permits it — then
    // connectivity() throws on the missing port before any connect() is attempted.
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'true');
    resetServerConfig();
    initNetDiagService();
    await expect(run({ mode: 'connectivity', target: '203.0.113.7' })).rejects.toThrow(
      /port is required/,
    );
  });

  it('permits a private loopback target through the gate when ALLOW_PRIVATE_NETWORK is on', async () => {
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'true');
    resetServerConfig();
    initNetDiagService();
    // Gate permits it; a TCP probe to a closed loopback port resolves
    // reachable:false (a valid down result), NOT the gate error.
    const result = await run({ mode: 'connectivity', target: '127.0.0.1', port: 1 });
    expect(result).toMatchObject({ mode: 'connectivity', target: '127.0.0.1', reachable: false });
  });

  it('returns the host egress IP for public_ip mode (stubbed upstream)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: async () => ({ ip: '203.0.113.99' }),
        text: async () => '{"ip":"203.0.113.99"}',
      } as unknown as Response),
    );
    const result = await run({ mode: 'public_ip' });
    expect(result).toMatchObject({ mode: 'public_ip', publicIp: '203.0.113.99' });
  });

  it('rejects an invalid target at the schema boundary', () => {
    // host:port inline syntax is explicitly disallowed (port is a separate param).
    expect(
      checkNetworkTool.input.safeParse({ mode: 'connectivity', target: 'db:5432' }).success,
    ).toBe(false);
    expect(checkNetworkTool.input.safeParse({ mode: 'ping', target: 'localhost' }).success).toBe(
      false,
    );
  });

  it('enforces count and port bounds', () => {
    expect(
      checkNetworkTool.input.safeParse({ mode: 'ping', target: '8.8.8.8', count: 0 }).success,
    ).toBe(false);
    expect(
      checkNetworkTool.input.safeParse({ mode: 'ping', target: '8.8.8.8', count: 11 }).success,
    ).toBe(false);
    expect(
      checkNetworkTool.input.safeParse({
        mode: 'connectivity',
        target: '8.8.8.8',
        port: 70000,
      }).success,
    ).toBe(false);
  });
});

describe('toolkit_check_network format()', () => {
  it('renders ping reachability and RTT', () => {
    const blocks = checkNetworkTool.format!({
      mode: 'ping',
      target: '8.8.8.8',
      reachable: true,
      rttMs: 12.5,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('ping');
    expect(text).toContain('8.8.8.8');
    expect(text).toContain('reachable');
    expect(text).toContain('12.5');
  });

  it('renders an unreachable host distinctly', () => {
    const blocks = checkNetworkTool.format!({
      mode: 'connectivity',
      target: '8.8.8.8',
      reachable: false,
    });
    expect((blocks[0] as { text: string }).text).toContain('NOT reachable');
  });

  it('renders the traceroute hop path', () => {
    const blocks = checkNetworkTool.format!({
      mode: 'traceroute',
      target: '8.8.8.8',
      hops: [
        { hop: 1, address: '192.0.2.1', rttMs: 1.2 },
        { hop: 2, address: '*' },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2 hops');
    expect(text).toContain('192.0.2.1');
    expect(text).toContain('*');
  });

  it('renders the public egress IP', () => {
    const blocks = checkNetworkTool.format!({ mode: 'public_ip', publicIp: '203.0.113.99' });
    expect((blocks[0] as { text: string }).text).toContain('203.0.113.99');
  });
});
