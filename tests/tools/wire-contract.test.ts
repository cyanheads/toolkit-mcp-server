/**
 * @fileoverview Pins the wire contract every tool on this server shares, as the
 * framework enforces it: input objects are strict at the root — an argument key
 * the schema does not declare is rejected by name rather than stripped — and no
 * tool may name an output field `error`, which is the failure envelope's key on
 * the wire. Both are framework-wide rules, so the guard runs across the whole
 * definition set rather than per tool: a later schema edit that reopens an input
 * or adds an `error` field fails here instead of on a client. The declared
 * `inputAliases` are pinned here too, since they are the one sanctioned way past
 * the strict root and must stay one-to-one with the keys they name.
 * @module tests/tools/wire-contract.test
 */

import { type AnyToolDefinition, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { checkNetworkTool } from '@/mcp-server/tools/definitions/check-network.tool.js';
import { checkSystemTool } from '@/mcp-server/tools/definitions/check-system.tool.js';
import { encodeValueTool } from '@/mcp-server/tools/definitions/encode-value.tool.js';
import { generateIdTool } from '@/mcp-server/tools/definitions/generate-id.tool.js';
import { generateQrTool } from '@/mcp-server/tools/definitions/generate-qr.tool.js';
import { geolocateIpTool } from '@/mcp-server/tools/definitions/geolocate-ip.tool.js';
import { hashValueTool } from '@/mcp-server/tools/definitions/hash-value.tool.js';
import { initGeoService } from '@/services/geo/geo-service.js';
import { initNetDiagService } from '@/services/network/net-diag-service.js';

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
  it.each([
    [encodeValueTool, { operation: 'decode', encoding: 'hex', value: 'xz' }, 'decode_failed'],
    [encodeValueTool, { operation: 'decode', encoding: 'hex', value: 'ff00fe' }, 'decode_not_utf8'],
    [
      encodeValueTool,
      { operation: 'encode', encoding: 'hex', value: 'abc', outputEncoding: 'hex' },
      'output_encoding_not_applicable',
    ],
    [hashValueTool, { operation: 'compare', value: 'abc' }, 'missing_expected'],
    [
      hashValueTool,
      { operation: 'generate', value: 'abc', expected: 'deadbeef' },
      'expected_without_compare',
    ],
    [
      hashValueTool,
      { operation: 'compare', value: 'abc', expected: 'bad' },
      'expected_length_mismatch',
    ],
    [hashValueTool, { operation: 'compare', value: 'abc', expected: '#' }, 'expected_malformed'],
    [
      hashValueTool,
      { value: 'abc', expected: `sha512-${Buffer.alloc(64).toString('base64')}` },
      'expected_algorithm_mismatch',
    ],
    [
      hashValueTool,
      { value: 'abc', algorithm: 'sha1', digestEncoding: 'sri' },
      'sri_unsupported_algorithm',
    ],
    [hashValueTool, { value: 'xz', inputEncoding: 'hex' }, 'invalid_input_encoding'],
    [generateQrTool, { data: 'x'.repeat(2953), errorCorrection: 'M' }, 'data_too_large'],
    [
      generateQrTool,
      { data: 'x'.repeat(2953), errorCorrection: 'L', format: 'png_base64', scale: 32 },
      'raster_too_large',
    ],
  ] as const)(
    'classifies %s domain rejection %s with recovery on both surfaces',
    async (definition, input, reason) => {
      const result = await runToolContract(definition, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason, recovery: { hint: expect.any(String) } },
        },
      });
      const { error } = z
        .object({
          error: z.object({
            message: z.string(),
            data: z.object({ recovery: z.object({ hint: z.string() }) }),
          }),
        })
        .parse(result.structuredContent);
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(error.message);
      expect(text).toContain(error.data.recovery.hint);
    },
  );

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

/**
 * An alias is not in the declared input type — that is the whole point of
 * declaring it — so the arguments are cast at this one boundary rather than at
 * each call site.
 */
const callWithArgs = (definition: AnyToolDefinition, args: Record<string, unknown>) =>
  runToolContract(definition, args as never);

/** SHA-256 of the ASCII string "abc". */
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

/** An RFC-1918 address — rejected before any DNS or provider call runs. */
const PRIVATE_IP = '10.0.0.1';

describe('declared input aliases', () => {
  beforeEach(() => {
    resetServerConfig();
    initGeoService();
    initNetDiagService();
  });

  it.each(['input', 'text', 'data'] as const)(
    'toolkit_encode_value accepts %s as value',
    async (alias) => {
      const result = await callWithArgs(encodeValueTool, {
        operation: 'encode',
        encoding: 'base64',
        [alias]: 'abc',
      });
      expect(result.structuredContent).toMatchObject({ result: 'YWJj' });
    },
  );

  it.each(['input', 'text', 'data'] as const)(
    'toolkit_hash_value accepts %s as value',
    async (alias) => {
      const result = await callWithArgs(hashValueTool, { [alias]: 'abc' });
      expect(result.structuredContent).toMatchObject({ digest: SHA256_ABC });
    },
  );

  it.each(['text', 'content', 'value'] as const)(
    'toolkit_generate_qr accepts %s as data',
    async (alias) => {
      const result = await callWithArgs(generateQrTool, { [alias]: 'https://example.com' });
      expect(result.structuredContent).toMatchObject({ format: 'svg', mimeType: 'image/svg+xml' });
    },
  );

  it.each(['ip', 'hostname', 'host'] as const)(
    'toolkit_geolocate_ip accepts %s as target',
    async (alias) => {
      // The private-range guard rejects before any provider call, so reaching
      // `private_target` proves the alias resolved to the declared key.
      const result = await callWithArgs(geolocateIpTool, { [alias]: PRIVATE_IP });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'private_target' } },
      });
    },
  );

  it.each(['ip', 'hostname', 'host'] as const)(
    'toolkit_check_network accepts %s as target',
    async (alias) => {
      const result = await callWithArgs(checkNetworkTool, { mode: 'ping', [alias]: PRIVATE_IP });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'private_target_blocked' } },
      });
    },
  );

  it.each([
    [
      'toolkit_encode_value',
      encodeValueTool,
      { operation: 'encode', encoding: 'base64', value: 'abc' },
      'input',
    ],
    ['toolkit_hash_value', hashValueTool, { value: 'abc' }, 'data'],
    ['toolkit_generate_qr', generateQrTool, { data: 'https://example.com' }, 'text'],
    ['toolkit_geolocate_ip', geolocateIpTool, { target: PRIVATE_IP }, 'ip'],
    ['toolkit_check_network', checkNetworkTool, { mode: 'ping', target: PRIVATE_IP }, 'host'],
  ] as const)(
    '%s leaves the declared key untouched when the alias is also sent',
    async (_name, definition, declared, alias) => {
      // A rewrite applies only when the target key is absent, so the alias can
      // never overwrite a value the caller declared — it stays an undeclared
      // root key and the strict root rejects it by name.
      const result = await callWithArgs(definition, { ...declared, [alias]: 'OVERRIDE' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect(JSON.stringify(result.structuredContent)).toContain(alias);
    },
  );
});
