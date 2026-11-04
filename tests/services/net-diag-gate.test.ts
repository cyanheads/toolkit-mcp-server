/**
 * @fileoverview Tests for the NetDiagService request-time gate — the SECOND tier
 * of the network gate (TOOLKIT_ALLOW_PRIVATE_NETWORK). With it off, private/
 * reserved targets (incl. the cloud-metadata endpoint) are rejected before any
 * probe runs, and a hostname resolving to public and private addresses is
 * probed on its public addresses only. `node:dns/promises` is mocked so a
 * hostname resolves to a chosen set; `node:net`'s `connect` runs for real (the
 * loopback probe) unless a test hands it stand-in sockets, so no packet reaches
 * a public address.
 * @module tests/services/net-diag-gate.test
 */

import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { getNetDiagService, initNetDiagService } from '@/services/network/net-diag-service.js';

const { lookupMock, connectMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  connectMock: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));
vi.mock('node:net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:net')>()),
  connect: connectMock,
}));
const { connect: realConnect } = await vi.importActual<typeof import('node:net')>('node:net');

const call = (target: string) =>
  getNetDiagService().run(
    { mode: 'connectivity', target, port: 80, count: 1, timeoutMs: 500 },
    createMockContext(),
  );

/**
 * The resolver answers `addresses` in this order: an `{ all: true }` lookup
 * gets every one, a bare lookup only the first — the two shapes `dns.lookup`
 * returns.
 */
const resolvesTo = (...addresses: string[]) =>
  lookupMock.mockImplementation(async (_host: string, options?: { all?: boolean }) => {
    const answers = addresses.map((address) => ({ address, family: isIP(address) }));
    return options?.all ? answers : answers[0];
  });

/** Every connect() is refused on the next turn, so each eligible address gets tried. */
const everyConnectRefused = () =>
  connectMock.mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() });
    setImmediate(() =>
      socket.emit(
        'error',
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      ),
    );
    return socket;
  });

/** The host each connect() call was handed, in call order. */
const connectedHosts = () =>
  connectMock.mock.calls.map((args) => (args[0] as { host: string }).host);

describe('NetDiagService private-range gate', () => {
  beforeEach(() => {
    resetServerConfig();
    initNetDiagService();
    lookupMock.mockReset();
    connectMock.mockReset();
    connectMock.mockImplementation(realConnect);
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

  describe('a hostname resolving to public and private addresses', () => {
    const MIXED = ['10.0.0.5', '93.184.216.34', 'fd00::1', '2606:2800:220:1::1', '169.254.169.254'];

    it('probes only its public addresses when the gate is off, never contacting a private one', async () => {
      vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'false');
      resetServerConfig();
      initNetDiagService();
      resolvesTo(...MIXED);
      everyConnectRefused();
      const result = await call('mixed.example.com');
      expect(connectedHosts()).toEqual(['93.184.216.34', '2606:2800:220:1::1']);
      expect(result).toMatchObject({ resolvedIp: '2606:2800:220:1::1', outcome: 'refused' });
    });

    it('blocks a hostname whose every address is private, counting them, before any probe', async () => {
      vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'false');
      resetServerConfig();
      initNetDiagService();
      resolvesTo('10.0.0.5', 'fd00::1');
      everyConnectRefused();
      await expect(call('internal.example.com')).rejects.toMatchObject({
        message:
          'internal.example.com has no public address; its 2 addresses are private/reserved.',
        data: { reason: 'private_target_blocked' },
      });
      expect(connectMock).not.toHaveBeenCalled();
    });

    it('probes every address, private ones included, when the gate is on', async () => {
      vi.stubEnv('TOOLKIT_ALLOW_PRIVATE_NETWORK', 'true');
      resetServerConfig();
      initNetDiagService();
      resolvesTo(...MIXED);
      everyConnectRefused();
      await call('mixed.example.com');
      expect(connectedHosts()).toEqual([
        '10.0.0.5',
        'fd00::1',
        '93.184.216.34',
        '2606:2800:220:1::1',
        '169.254.169.254',
      ]);
    });
  });
});
