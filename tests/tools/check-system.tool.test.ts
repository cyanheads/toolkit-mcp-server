/**
 * @fileoverview Tests for toolkit_check_system — each facet returns its own
 * shape keyed by `what`, reading os/process read-only.
 * @module tests/tools/check-system.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { checkSystemTool } from '@/mcp-server/tools/definitions/check-system.tool.js';

const run = (what: string) =>
  checkSystemTool.handler(checkSystemTool.input.parse({ what }), createMockContext());

describe('toolkit_check_system', () => {
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

  it.each([
    'os',
    'cpu',
    'memory',
    'load',
    'interfaces',
  ])('output conforms to the declared schema for the %s facet', async (what) => {
    const result = await run(what);
    expect(result).toEqual(expect.schemaMatching(checkSystemTool.output));
  });

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
        memory: { totalBytes: 17179869184, freeBytes: 8589934592, usedBytes: 8589934592 },
      })[0] as { text: string }
    ).text;
    // The byte fields the schema declares appear verbatim (format-parity).
    expect(text).toContain('17179869184');
    expect(text).toContain('8589934592');
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
