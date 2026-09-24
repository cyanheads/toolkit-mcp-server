/**
 * @fileoverview Tests for toolkit_encode_value — round-trips across every
 * encoding, byte-preserving decode via outputEncoding, whitespace-tolerant
 * hex/base64 input, and the decode_failed / decode_not_utf8 /
 * output_encoding_not_applicable contract.
 * @module tests/tools/encode-value.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

  it.each([
    ['a lone percent sign', '%'],
    ['a truncated escape', 'abc%4'],
    ['a non-hex escape', '%G1'],
  ])('throws decode_failed on url input with %s', (_label, value) => {
    expect(reasonOf({ operation: 'decode', encoding: 'url', value })).toBe('decode_failed');
  });
});

/** SHA-256 of the ASCII string "abc", as hex and as standard base64. */
const SHA256_ABC_HEX = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const SHA256_ABC_B64 = Buffer.from(SHA256_ABC_HEX, 'hex').toString('base64');

/** The eight PNG signature bytes. */
const PNG_MAGIC_HEX = '89504e470d0a1a0a';

describe('toolkit_encode_value byte-preserving decode', () => {
  it.each([
    ['hex', 'ff00fe'],
    ['base64', 'iVBORw0KGgo='], // PNG signature — 0x89 is not a UTF-8 lead byte
    ['base64url', Buffer.from([0xc3, 0x28]).toString('base64url')], // bad continuation byte
    ['url', '%FF%FE'],
  ] as const)('refuses to decode non-UTF-8 %s bytes as text (%j)', async (encoding, value) => {
    const error = await Promise.resolve()
      .then(() => run({ operation: 'decode', encoding, value }))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'decode_not_utf8' },
    });
  });

  it('never returns U+FFFD for bytes the source did not contain', async () => {
    const result = await Promise.resolve()
      .then(() => run({ operation: 'decode', encoding: 'hex', value: 'ff00fe' }))
      .catch(() => undefined);
    expect(result?.result ?? '').not.toContain('�');
  });

  it.each([
    ['hex', PNG_MAGIC_HEX],
    ['base64', 'iVBORw0KGgo='],
  ] as const)(
    'outputEncoding %s returns the exact PNG signature bytes',
    async (outputEncoding, expected) => {
      const result = await run({
        operation: 'decode',
        encoding: 'base64',
        value: 'iVBORw0KGgo=',
        outputEncoding,
      });
      expect(result).toEqual({
        encoding: 'base64',
        operation: 'decode',
        outputEncoding,
        result: expected,
      });
    },
  );

  it('transcodes a base64 digest to hex', async () => {
    const result = await run({
      operation: 'decode',
      encoding: 'base64',
      value: SHA256_ABC_B64,
      outputEncoding: 'hex',
    });
    expect(result.result).toBe(SHA256_ABC_HEX);
  });

  it('transcodes a hex digest to base64', async () => {
    const result = await run({
      operation: 'decode',
      encoding: 'hex',
      value: SHA256_ABC_HEX,
      outputEncoding: 'base64',
    });
    expect(result.result).toBe(SHA256_ABC_B64);
  });

  it('decodes percent-escaped bytes that are not UTF-8 when asked for hex', async () => {
    const result = await run({
      operation: 'decode',
      encoding: 'url',
      value: 'a%FF%00b',
      outputEncoding: 'hex',
    });
    expect(result.result).toBe('61ff0062');
  });

  it('keeps a leading byte-order mark rather than stripping it', async () => {
    const result = await run({ operation: 'decode', encoding: 'hex', value: 'efbbbf41' });
    expect(result.result).toBe('﻿A');
  });

  it('resolves an omitted outputEncoding to utf8 and echoes it', async () => {
    const result = await run({ operation: 'decode', encoding: 'hex', value: '616263' });
    expect(result).toEqual({
      encoding: 'hex',
      operation: 'decode',
      outputEncoding: 'utf8',
      result: 'abc',
    });
  });

  it('round-trips an empty value through every outputEncoding', async () => {
    for (const outputEncoding of ['utf8', 'hex', 'base64'] as const) {
      const result = await run({
        operation: 'decode',
        encoding: 'base64',
        value: '',
        outputEncoding,
      });
      expect(result.result).toBe('');
    }
  });

  it('decodes MIME-wrapped base64 once line breaks are stripped', async () => {
    const result = await run({
      operation: 'decode',
      encoding: 'base64',
      value: 'aGVsbG8g\nd29ybGQ=',
    });
    expect(result.result).toBe('hello world');
  });

  it('decodes PEM-style base64 wrapped at 64 columns with CRLF and indentation', async () => {
    const bytes = Buffer.from(Array.from({ length: 150 }, (_, i) => i));
    const wrapped = (bytes.toString('base64').match(/.{1,64}/g) as string[])
      .map((line) => `  ${line}`)
      .join('\r\n');
    const result = await run({
      operation: 'decode',
      encoding: 'base64',
      value: wrapped,
      outputEncoding: 'hex',
    });
    expect(result.result).toBe(bytes.toString('hex'));
  });

  it('strips whitespace from wrapped base64url', async () => {
    const result = await run({
      operation: 'decode',
      encoding: 'base64url',
      value: '-_8\n',
      outputEncoding: 'hex',
    });
    expect(result.result).toBe('fbff');
  });

  it('strips whitespace from spaced and wrapped hex', async () => {
    const result = await run({
      operation: 'decode',
      encoding: 'hex',
      value: 'de ad\nbe\tef',
      outputEncoding: 'hex',
    });
    expect(result.result).toBe('deadbeef');
  });

  it('fails a url value with an unpaired surrogate rather than substituting bytes for it', () => {
    // A lone surrogate has no UTF-8 encoding; Buffer would silently write
    // EF BF BD (U+FFFD) in its place.
    expect(
      reasonOf({ operation: 'decode', encoding: 'url', value: 'a\uD800b', outputEncoding: 'hex' }),
    ).toBe('decode_failed');
  });

  it('leaves whitespace in a url value as literal text', async () => {
    const result = await run({ operation: 'decode', encoding: 'url', value: 'a%20b c\n' });
    expect(result.result).toBe('a b c\n');
  });

  it('still fails a value that is malformed once whitespace is gone', () => {
    expect(reasonOf({ operation: 'decode', encoding: 'hex', value: 'ab c' })).toBe('decode_failed');
    expect(reasonOf({ operation: 'decode', encoding: 'base64', value: 'ab c!' })).toBe(
      'decode_failed',
    );
  });

  it('rejects outputEncoding on encode instead of ignoring it', () => {
    expect(
      reasonOf({ operation: 'encode', encoding: 'hex', value: 'abc', outputEncoding: 'hex' }),
    ).toBe('output_encoding_not_applicable');
  });

  it('keeps outputEncoding off the encode output', async () => {
    const result = await run({ operation: 'encode', encoding: 'hex', value: 'abc' });
    expect(result).toEqual({ encoding: 'hex', operation: 'encode', result: '616263' });
  });

  it('advertises outputEncoding as optional with no default', () => {
    const schema = z.toJSONSchema(encodeValueTool.input) as {
      properties: Record<string, { default?: unknown }>;
      required?: string[];
    };
    expect(schema.properties.outputEncoding).toBeDefined();
    expect(schema.properties.outputEncoding?.default).toBeUndefined();
    expect(schema.required ?? []).not.toContain('outputEncoding');
  });

  it('format renders outputEncoding alongside the decoded bytes', async () => {
    const result = encodeValueTool.output.parse(
      await run({
        operation: 'decode',
        encoding: 'base64',
        value: 'iVBORw0KGgo=',
        outputEncoding: 'hex',
      }),
    );
    const text = (encodeValueTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('outputEncoding: hex');
    expect(text).toContain(PNG_MAGIC_HEX);
  });

  it.each([
    [
      { operation: 'decode', encoding: 'hex', value: 'ff00fe' },
      'decode_not_utf8',
      /outputEncoding/,
    ],
    [
      { operation: 'encode', encoding: 'hex', value: 'abc', outputEncoding: 'base64' },
      'output_encoding_not_applicable',
      /decode/,
    ],
  ] as const)(
    'puts %j on the wire as %s with its recovery hint',
    async (input, reason, hintPattern) => {
      const result = await runToolContract(encodeValueTool, input);
      expect(result.isError).toBe(true);
      const { error } = z
        .object({
          error: z.object({
            code: z.number(),
            message: z.string(),
            data: z.object({ reason: z.string(), recovery: z.object({ hint: z.string() }) }),
          }),
        })
        .parse(result.structuredContent);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe(reason);
      expect(error.data.recovery.hint).toMatch(hintPattern);
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(error.message);
      expect(text).toContain(error.data.recovery.hint);
      expect(text).toContain(reason);
    },
  );

  it('returns the decoded bytes on both surfaces through the contract runner', async () => {
    const result = await runToolContract(encodeValueTool, {
      operation: 'decode',
      encoding: 'base64',
      value: 'iVBORw0KGgo=',
      outputEncoding: 'hex',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      encoding: 'base64',
      operation: 'decode',
      outputEncoding: 'hex',
      result: PNG_MAGIC_HEX,
    });
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain(PNG_MAGIC_HEX);
    expect(text).toContain('hex');
  });
});
