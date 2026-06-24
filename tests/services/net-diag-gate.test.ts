/**
 * @fileoverview Tests for the NetDiagService request-time gate — the SECOND tier
 * of the network gate (TOOLKIT_ALLOW_PRIVATE_NETWORK). With it off, private/
 * reserved targets (incl. the cloud-metadata endpoint) are rejected before any
 * probe runs. These tests exercise only the gate path, not live network I/O.
 * @module tests/services/net-diag-gate.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { getNetDiagService, initNetDiagService } from '@/services/network/net-diag-service.js';

const call = (target: string) =>
  getNetDiagService().run(
    { mode: 'connectivity', target, port: 80, count: 1, timeoutMs: 500 },
    createMockContext(),
  );

describe('NetDiagService private-range gate', () => {
  beforeEach(() => {
    resetServerConfig();
    initNetDiagService();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it('blocks the cloud-metadata endpoint when ALLOW_PRIVATE_NETWORK is off', async () => {
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'false');
    resetServerConfig();
    initNetDiagService();
    await expect(call('169.254.169.254')).rejects.toMatchObject({
      data: { reason: 'private_target_blocked' },
    });
  });

  it('blocks an RFC-1918 target when the gate is off', async () => {
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'false');
    resetServerConfig();
    initNetDiagService();
    await expect(call('10.0.0.1')).rejects.toMatchObject({
      data: { reason: 'private_target_blocked' },
    });
  });

  it('does NOT block a private target through the gate when ALLOW_PRIVATE_NETWORK is on', async () => {
    vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'true');
    resetServerConfig();
    initNetDiagService();
    // Gate permits the target; the TCP probe to a closed port resolves
    // reachable:false (a valid result) rather than throwing the gate error.
    const result = await call('127.0.0.1');
    expect(result).toMatchObject({ mode: 'connectivity', target: '127.0.0.1', reachable: false });
  });
});
