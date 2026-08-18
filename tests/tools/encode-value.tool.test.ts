/**
 * @fileoverview Tests for toolkit_encode_value — round-trips across every
 * encoding and the decode_failed contract.
 * @module tests/tools/encode-value.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { encodeValueTool } from '@/mcp-server/tools/definitions/encode-value.tool.js';

const run = (args: unknown) =>
  encodeValueTool.handler(
    encodeValueTool.input.parse(args),
    createMockContext({ errors: encodeValueTool.errors }),
  );

/** Capture the reason from a synchronously-thrown McpError. */
const reasonOf = (args: unknown): string | undefined => {
  try {
    run(args);
  } catch (err) {
    return (err as { data?: { reason?: string } })?.data?.reason;
  }
  return;
};

describe('toolkit_encode_value', () => {
  it.each([
    ['base64', 'aGVsbG8gd29ybGQ='],
    ['base64url', 'aGVsbG8gd29ybGQ'],
    ['hex', '68656c6c6f20776f726c64'],
    ['url', 'hello%20world'],
  ])('encodes "hello world" to %s correctly', async (encoding, expected) => {
    const result = await run({ operation: 'encode', encoding, value: 'hello world' });
    expect(result.result).toBe(expected);
  });

  it.each(['base64', 'base64url', 'hex', 'url'] as const)(
    'round-trips through %s',
    async (encoding) => {
      const original = 'The quick brown fox: 1+1=2 & more!';
      const enc = await run({ operation: 'encode', encoding, value: original });
      const dec = await run({ operation: 'decode', encoding, value: enc.result });
      expect(dec.result).toBe(original);
    },
  );

  it('base64url uses the URL-safe alphabet (- _ not + /)', async () => {
    // Bytes 0xFB 0xFF encode to "+/8=" in base64 and "-_8" in base64url.
    const std = await run({ operation: 'encode', encoding: 'base64', value: 'ûÿ' });
    const url = await run({ operation: 'encode', encoding: 'base64url', value: 'ûÿ' });
    expect(std.result).not.toBe(url.result);
    expect(url.result).not.toMatch(/[+/]/);
  });

  it.each([
    ['hex', 'zz'], // non-hex characters
    ['hex', 'abc'], // odd length
    ['base64', '@@@@'], // outside the base64 alphabet
    ['base64url', 'a+/b'], // standard-base64 chars are invalid for base64url
  ] as const)('throws decode_failed on malformed %s input (%j)', (encoding, value) => {
    expect(reasonOf({ operation: 'decode', encoding, value })).toBe('decode_failed');
  });

  it('decodes a base64url value that standard base64 would reject', async () => {
    // Bytes 0xFB 0xFF → "-_8" in base64url. Decoding it back recovers the bytes.
    const enc = await run({ operation: 'encode', encoding: 'base64url', value: 'ûÿ' });
    const dec = await run({ operation: 'decode', encoding: 'base64url', value: enc.result });
    expect(dec.result).toBe('ûÿ');
  });

  it('round-trips an empty string through every encoding', async () => {
    for (const encoding of ['base64', 'base64url', 'hex', 'url'] as const) {
      const enc = await run({ operation: 'encode', encoding, value: '' });
      expect(enc.result).toBe('');
      const dec = await run({ operation: 'decode', encoding, value: '' });
      expect(dec.result).toBe('');
    }
  });

  it('url-encodes reserved characters and unicode', async () => {
    const enc = await run({ operation: 'encode', encoding: 'url', value: 'a b&c=ñ' });
    expect(enc.result).toBe('a%20b%26c%3D%C3%B1');
    const dec = await run({ operation: 'decode', encoding: 'url', value: enc.result });
    expect(dec.result).toBe('a b&c=ñ');
  });

  it('output conforms to the declared schema', async () => {
    const result = await run({ operation: 'encode', encoding: 'hex', value: 'abc' });
    expect(result).toEqual(expect.schemaMatching(encodeValueTool.output));
  });

  it('format fences plain content with a standard triple-backtick block', async () => {
    const dec = await run({ operation: 'decode', encoding: 'hex', value: '616263' });
    const text = (encodeValueTool.format!(dec)[0] as { text: string }).text;
    expect(text).toContain('\n```\nabc\n```');
  });

  it.each([
    // Decoded text that opens its own fence, then Markdown and angle-bracket
    // content the surrounding fence must keep literal.
    ['a fence with an info string', 'YGBgeAojIEhlYWRpbmcKPHRhZz4mXzwvdGFnPg=='],
    // A bare triple-backtick line — the classic fence break.
    ['a bare fence line', Buffer.from('before\n```\nafter').toString('base64')],
    // A run longer than three, so a four-backtick fence would break too.
    ['a six-backtick run', Buffer.from('``````\nx').toString('base64')],
    // Backticks at the very edges of the payload.
    ['leading and trailing backticks', Buffer.from('`edge`').toString('base64')],
  ])('format keeps decoded content carrying %s inside its fence', async (_label, value) => {
    const dec = await run({ operation: 'decode', encoding: 'base64', value });
    const text = (encodeValueTool.format!(dec)[0] as { text: string }).text;
    const lines = text.split('\n');
    const openIndex = lines.findIndex((line) => /^`{3,}$/.test(line));
    expect(openIndex).toBeGreaterThan(-1);
    // A fenced block closes on any backtick-only line at least as long as its
    // opener, so that — not string equality — is what the payload must never
    // produce. Exactly two such lines means the opener and its own closer.
    const delimiter = new RegExp(`^\`{${(lines[openIndex] as string).length},}$`);
    expect(lines.filter((line) => delimiter.test(line))).toHaveLength(2);
    // And the block's body is the decoded value, byte for byte.
    expect(
      lines
        .slice(
          openIndex + 1,
          lines.findLastIndex((line) => delimiter.test(line)),
        )
        .join('\n'),
    ).toBe(dec.result);
  });

  it('format renders the transformed value and direction', async () => {
    const enc = await run({ operation: 'encode', encoding: 'hex', value: 'abc' });
    const encText = (encodeValueTool.format!(enc)[0] as { text: string }).text;
    expect(encText).toContain('Encoded');
    expect(encText).toContain('616263'); // hex of "abc"

    const dec = await run({ operation: 'decode', encoding: 'hex', value: '616263' });
    const decText = (encodeValueTool.format!(dec)[0] as { text: string }).text;
    expect(decText).toContain('Decoded');
    expect(decText).toContain('abc');
  });
});
