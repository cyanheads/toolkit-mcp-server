/**
 * @fileoverview Pins the wire contract every tool on this server shares, as the
 * framework enforces it: input objects are strict at the root — an argument key
 * the schema does not declare is rejected by name rather than stripped — and no
 * tool may name an output field `error`, which is the failure envelope's key on
 * the wire. Both are framework-wide rules, so the guard runs across the whole
 * definition set rather than per tool: a later schema edit that reopens an input
 * or adds an `error` field fails here instead of on a client.
 * @module tests/tools/wire-contract.test
 */

import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { checkNetworkTool } from '@/mcp-server/tools/definitions/check-network.tool.js';
import { checkSystemTool } from '@/mcp-server/tools/definitions/check-system.tool.js';
import { encodeValueTool } from '@/mcp-server/tools/definitions/encode-value.tool.js';
import { generateIdTool } from '@/mcp-server/tools/definitions/generate-id.tool.js';
import { generateQrTool } from '@/mcp-server/tools/definitions/generate-qr.tool.js';
import { geolocateIpTool } from '@/mcp-server/tools/definitions/geolocate-ip.tool.js';
import { hashValueTool } from '@/mcp-server/tools/definitions/hash-value.tool.js';

/** Every tool this server can register — the five always-on plus the two gated. */
const ALL_TOOLS: AnyToolDefinition[] = [
  hashValueTool,
  generateIdTool,
  generateQrTool,
  encodeValueTool,
  geolocateIpTool,
  checkNetworkTool,
  checkSystemTool,
];

/** A minimal valid argument set per tool, so only the injected key is at fault. */
const VALID_INPUT: Record<string, Record<string, unknown>> = {
  toolkit_hash_value: { value: 'abc' },
  toolkit_generate_id: {},
  toolkit_generate_qr: { data: 'https://example.com' },
  toolkit_encode_value: { operation: 'encode', encoding: 'base64', value: 'abc' },
  toolkit_geolocate_ip: { target: '8.8.8.8' },
  toolkit_check_network: { mode: 'public_ip' },
  toolkit_check_system: { what: 'os' },
};

describe('tool wire contract', () => {
  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
    '%s accepts its own minimal valid input',
    (name, definition) => {
      expect(definition.input.safeParse(VALID_INPUT[name]).success).toBe(true);
    },
  );

  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
    '%s rejects an undeclared argument key by name rather than stripping it',
    (name, definition) => {
      const result = definition.input.safeParse({
        ...VALID_INPUT[name],
        notAToolkitParam: 'should be rejected',
      });
      expect(result.success).toBe(false);
      // The key must appear in the diagnostic — a silent strip turns a caller's
      // typo into a wrong answer they cannot detect.
      expect(JSON.stringify(result.error?.issues)).toContain('notAToolkitParam');
    },
  );

  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
    '%s declares no output field named `error`',
    (_name, definition) => {
      // `structuredContent.error` IS the failure envelope; a success payload
      // using the key would be indistinguishable from a failure on the wire.
      expect(Object.keys(definition.output.shape)).not.toContain('error');
    },
  );

  it('rejects a near-miss key that another tool on this server does declare', () => {
    // `encoding` belongs to toolkit_encode_value; toolkit_hash_value spells the
    // same idea `inputEncoding`. Stripping it would silently hash the raw utf8
    // bytes and report a digest for input the caller never meant to send.
    const result = hashValueTool.input.safeParse({
      value: 'deadbeef',
      encoding: 'hex',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('encoding');
  });
});
