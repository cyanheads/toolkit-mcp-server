/**
 * @fileoverview Tests for toolkit_hash_value — known-vector digests, constant-time
 * compare, omitted-operation resolution, hex/base64/SRI digests, input-encoding
 * handling, and the domain error contract.
 * @module tests/tools/hash-value.tool.test
 */

import { createHash } from 'node:crypto';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { hashValueTool } from '@/mcp-server/tools/definitions/hash-value.tool.js';

/** SHA-256 of the ASCII string "abc". */
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

const run = (args: unknown) =>
  hashValueTool.handler(
    hashValueTool.input.parse(args),
    createMockContext({ errors: hashValueTool.errors }),
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

describe('toolkit_hash_value', () => {
  it('generates the known sha256 vector for "abc"', async () => {
    const result = await run({ operation: 'generate', value: 'abc', algorithm: 'sha256' });
    expect(result).toEqual({
      algorithm: 'sha256',
      operation: 'generate',
      digest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      lengthInBytes: 32,
    });
  });

  it('reports the correct digest length per algorithm', async () => {
    expect(
      (await run({ operation: 'generate', value: 'x', algorithm: 'sha512' })).lengthInBytes,
    ).toBe(64);
    expect(
      (await run({ operation: 'generate', value: 'x', algorithm: 'sha1' })).lengthInBytes,
    ).toBe(20);
    expect((await run({ operation: 'generate', value: 'x', algorithm: 'md5' })).lengthInBytes).toBe(
      16,
    );
  });

  it('compare returns matches:true for an equal digest', async () => {
    const result = await run({
      operation: 'compare',
      value: 'abc',
      algorithm: 'sha256',
      expected: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
    expect(result).toEqual({ algorithm: 'sha256', operation: 'compare', matches: true });
  });

  it('compare returns matches:false for a different value', async () => {
    const result = await run({
      operation: 'compare',
      value: 'abd',
      algorithm: 'sha256',
      expected: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
    expect(result).toMatchObject({ operation: 'compare', matches: false });
  });

  it('hashes hex- and base64-encoded input identically to its bytes', async () => {
    // "abc" as utf8, hex (616263), and base64 (YWJj) must all hash the same.
    const utf8 = await run({ operation: 'generate', value: 'abc', inputEncoding: 'utf8' });
    const hex = await run({ operation: 'generate', value: '616263', inputEncoding: 'hex' });
    const b64 = await run({ operation: 'generate', value: 'YWJj', inputEncoding: 'base64' });
    expect(hex.digest).toBe(utf8.digest);
    expect(b64.digest).toBe(utf8.digest);
  });

  it('throws missing_expected when compare has no expected digest', () => {
    expect(reasonOf({ operation: 'compare', value: 'abc', algorithm: 'sha256' })).toBe(
      'missing_expected',
    );
  });

  it('throws expected_length_mismatch when expected is the wrong length', () => {
    expect(
      reasonOf({ operation: 'compare', value: 'abc', algorithm: 'sha256', expected: 'deadbeef' }),
    ).toBe('expected_length_mismatch');
  });

  it('throws invalid_input_encoding for non-hex input declared as hex', () => {
    expect(reasonOf({ operation: 'generate', value: 'nothex!', inputEncoding: 'hex' })).toBe(
      'invalid_input_encoding',
    );
  });

  it('throws invalid_input_encoding for odd-length hex', () => {
    // Valid hex chars but an odd length is not a whole byte sequence.
    expect(reasonOf({ operation: 'generate', value: 'abc', inputEncoding: 'hex' })).toBe(
      'invalid_input_encoding',
    );
  });

  it('throws invalid_input_encoding for malformed base64 input', () => {
    expect(
      reasonOf({ operation: 'generate', value: 'not_base64!!', inputEncoding: 'base64' }),
    ).toBe('invalid_input_encoding');
  });

  it('matches the known md5 and sha1 vectors for "abc"', async () => {
    expect((await run({ operation: 'generate', value: 'abc', algorithm: 'md5' })).digest).toBe(
      '900150983cd24fb0d6963f7d28e17f72',
    );
    expect((await run({ operation: 'generate', value: 'abc', algorithm: 'sha1' })).digest).toBe(
      'a9993e364706816aba3e25717850c26c9cd0d89d',
    );
  });

  it('compare normalizes the expected digest (trims and lowercases)', async () => {
    // Surrounding whitespace and uppercase still match the lowercase-hex digest.
    const result = await run({
      operation: 'compare',
      value: 'abc',
      algorithm: 'sha256',
      expected: '  BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD  ',
    });
    expect(result).toMatchObject({ operation: 'compare', matches: true });
  });

  it('throws expected_length_mismatch when expected has non-hex characters', () => {
    // 64 chars but not all hex — caught by the hex+length pre-check.
    expect(
      reasonOf({
        operation: 'compare',
        value: 'abc',
        algorithm: 'sha256',
        expected: 'z'.repeat(64),
      }),
    ).toBe('expected_length_mismatch');
  });

  it('defaults operation to generate and algorithm to sha256', async () => {
    const result = await run({ value: 'abc' });
    expect(result.operation).toBe('generate');
    expect(result.algorithm).toBe('sha256');
    expect(result.digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('output conforms to the declared schema', async () => {
    const result = await run({ operation: 'generate', value: 'abc' });
    expect(result).toEqual(expect.schemaMatching(hashValueTool.output));
  });

  it('format renders the digest for generate', () => {
    const blocks = hashValueTool.format!({
      algorithm: 'sha256',
      operation: 'generate',
      digest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      lengthInBytes: 32,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('sha256');
    expect(text).toContain('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(text).toContain('32 bytes');
  });

  it('format renders the verdict for a compare match and mismatch', () => {
    const yes = (
      hashValueTool.format!({ algorithm: 'sha256', operation: 'compare', matches: true })[0] as {
        text: string;
      }
    ).text;
    expect(yes).toMatch(/Matches:\*\* yes/);
    const no = (
      hashValueTool.format!({ algorithm: 'sha256', operation: 'compare', matches: false })[0] as {
        text: string;
      }
    ).text;
    expect(no).toMatch(/Matches:\*\* no/);
  });
});

/** Parse a tool error envelope off `structuredContent` and the joined text of `content[]`. */
const wireError = async (input: Record<string, unknown>) => {
  const result = await runToolContract(hashValueTool, input as never);
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
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return { error, text };
};

const digestOf = (algorithm: string, value: string) =>
  createHash(algorithm).update(value, 'utf8').digest();

const ZERO_SHA256 = '0'.repeat(64);

describe('toolkit_hash_value operation resolution', () => {
  it('compares when expected is sent and operation is omitted', async () => {
    const result = await run({ value: 'hello', expected: ZERO_SHA256 });
    expect(result).toEqual({ algorithm: 'sha256', operation: 'compare', matches: false });
  });

  it('reports a match when the omitted-operation expected is the real digest', async () => {
    const result = await run({
      value: 'hello',
      expected: digestOf('sha256', 'hello').toString('hex'),
    });
    expect(result).toEqual({ algorithm: 'sha256', operation: 'compare', matches: true });
  });

  it('rejects an explicit generate sent with expected instead of ignoring expected', () => {
    expect(reasonOf({ operation: 'generate', value: 'hello', expected: ZERO_SHA256 })).toBe(
      'expected_without_compare',
    );
  });

  it('still throws missing_expected for compare with no expected', () => {
    expect(reasonOf({ operation: 'compare', value: 'hello' })).toBe('missing_expected');
  });

  it('still resolves a bare value to generate', async () => {
    const result = await run({ value: 'hello' });
    expect(result.operation).toBe('generate');
    expect(result.digest).toBe(digestOf('sha256', 'hello').toString('hex'));
  });

  it.each(['', '   '])(
    'treats an empty expected (%j) from a form client as absent',
    async (expected) => {
      expect((await run({ value: 'abc', expected })).operation).toBe('generate');
      expect((await run({ operation: 'generate', value: 'abc', expected })).operation).toBe(
        'generate',
      );
      expect(reasonOf({ operation: 'compare', value: 'abc', expected })).toBe('missing_expected');
    },
  );

  it('advertises operation as optional with no default', () => {
    const schema = z.toJSONSchema(hashValueTool.input) as {
      properties: Record<string, { default?: unknown }>;
      required?: string[];
    };
    expect(schema.properties.operation?.default).toBeUndefined();
    expect(schema.required ?? []).not.toContain('operation');
  });

  it('puts expected_without_compare on the wire with its recovery hint', async () => {
    const { error, text } = await wireError({
      operation: 'generate',
      value: 'hello',
      expected: ZERO_SHA256,
    });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('expected_without_compare');
    expect(error.data.recovery.hint).toMatch(/compare/);
    expect(text).toContain(error.data.recovery.hint);
  });

  it('returns the resolved compare on both surfaces', async () => {
    const result = await runToolContract(hashValueTool, {
      value: 'abc',
      expected: SHA256_ABC,
    } as never);
    expect(result.structuredContent).toEqual({
      algorithm: 'sha256',
      operation: 'compare',
      matches: true,
    });
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain('compare');
    expect(text).toMatch(/Matches:\*\* yes/);
  });
});

/** The SRI form of sha512("hello") from the lockfile-integrity example. */
const SRI_SHA512_HELLO =
  'sha512-m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==';

describe('toolkit_hash_value base64, SRI, and sha384', () => {
  it('generates the known sha384 vector for "abc"', async () => {
    const result = await run({ value: 'abc', algorithm: 'sha384' });
    expect(result).toEqual({
      algorithm: 'sha384',
      operation: 'generate',
      digest:
        'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
      lengthInBytes: 48,
    });
  });

  it('matches the lockfile SRI example', async () => {
    const result = await run({
      operation: 'compare',
      algorithm: 'sha512',
      value: 'hello',
      expected: SRI_SHA512_HELLO,
    });
    expect(result).toEqual({ algorithm: 'sha512', operation: 'compare', matches: true });
  });

  it.each([
    ['hex', digestOf('sha512', 'hello').toString('hex')],
    ['bare base64', digestOf('sha512', 'hello').toString('base64')],
    ['uppercase hex', digestOf('sha512', 'hello').toString('hex').toUpperCase()],
    ['padded base64', `  ${digestOf('sha512', 'hello').toString('base64')}\n`],
  ])('matches the same sha512 digest written as %s', async (_label, expected) => {
    const result = await run({
      operation: 'compare',
      algorithm: 'sha512',
      value: 'hello',
      expected,
    });
    expect(result.matches).toBe(true);
  });

  it('reports a mismatch for a well-formed base64 digest of other data', async () => {
    const result = await run({
      operation: 'compare',
      algorithm: 'sha256',
      value: 'hello',
      expected: digestOf('sha256', 'world').toString('base64'),
    });
    expect(result.matches).toBe(false);
  });

  it.each(['sha256', 'sha384', 'sha512'] as const)(
    'round-trips base64 and sri digests through compare for %s',
    async (algorithm) => {
      for (const digestEncoding of ['base64', 'sri'] as const) {
        const generated = await run({ value: 'payload', algorithm, digestEncoding });
        const raw = digestOf(algorithm, 'payload').toString('base64');
        expect(generated.digest).toBe(digestEncoding === 'sri' ? `${algorithm}-${raw}` : raw);
        expect(generated.lengthInBytes).toBe(digestOf(algorithm, 'payload').length);
        const compared = await run({
          operation: 'compare',
          algorithm,
          value: 'payload',
          expected: generated.digest,
        });
        expect(compared.matches).toBe(true);
      }
    },
  );

  it.each(['sha1', 'md5'] as const)('emits a base64 digest for %s', async (algorithm) => {
    const result = await run({ value: 'abc', algorithm, digestEncoding: 'base64' });
    expect(result.digest).toBe(digestOf(algorithm, 'abc').toString('base64'));
  });

  it('keeps generate output lowercase hex by default', async () => {
    const result = await run({ value: 'abc', digestEncoding: 'hex' });
    expect(result.digest).toBe(SHA256_ABC);
  });

  it('reads a hex sha256 expected as hex, never base64', async () => {
    // 64 hex characters are also valid base64, but decode to 48 bytes as base64 —
    // the wrong length for sha256 — so only the hex reading can match.
    const result = await run({
      operation: 'compare',
      algorithm: 'sha256',
      value: 'abc',
      expected: SHA256_ABC,
    });
    expect(result.matches).toBe(true);
  });

  it.each([
    ['a stray character', 'not a digest!'],
    ['an unknown SRI algorithm', `md5-${digestOf('md5', 'abc').toString('base64')}`],
    ['an SRI prefix with an empty body', 'sha256-'],
    ['an SRI body outside the base64 alphabet', 'sha256-###'],
  ])('throws expected_malformed for %s', (_label, expected) => {
    expect(reasonOf({ operation: 'compare', algorithm: 'sha256', value: 'abc', expected })).toBe(
      'expected_malformed',
    );
  });

  it('throws expected_algorithm_mismatch for an SRI naming another algorithm', () => {
    expect(
      reasonOf({
        operation: 'compare',
        algorithm: 'sha256',
        value: 'hello',
        expected: SRI_SHA512_HELLO,
      }),
    ).toBe('expected_algorithm_mismatch');
  });

  it.each([
    ['a 40-character hex digest', 'a'.repeat(40)],
    ['a base64 sha1 digest', digestOf('sha1', 'abc').toString('base64')],
    ['an SRI digest of the wrong length', `sha256-${digestOf('sha1', 'abc').toString('base64')}`],
  ])('keeps expected_length_mismatch for %s under sha256', (_label, expected) => {
    expect(reasonOf({ operation: 'compare', algorithm: 'sha256', value: 'abc', expected })).toBe(
      'expected_length_mismatch',
    );
  });

  it.each(['md5', 'sha1'] as const)(
    'throws sri_unsupported_algorithm for sri with %s',
    (algorithm) => {
      expect(reasonOf({ value: 'abc', algorithm, digestEncoding: 'sri' })).toBe(
        'sri_unsupported_algorithm',
      );
    },
  );

  it('format renders an SRI digest verbatim', async () => {
    const result = hashValueTool.output.parse(
      await run({ value: 'hello', algorithm: 'sha512', digestEncoding: 'sri' }),
    );
    const text = (hashValueTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain(SRI_SHA512_HELLO);
    expect(text).toContain('sha512');
    expect(text).toContain('64 bytes');
  });

  it.each([
    [
      { operation: 'compare', algorithm: 'sha256', value: 'abc', expected: 'not a digest!' },
      'expected_malformed',
      /hex|base64/i,
    ],
    [
      { operation: 'compare', algorithm: 'sha256', value: 'hello', expected: SRI_SHA512_HELLO },
      'expected_algorithm_mismatch',
      /sha512/,
    ],
    [
      { value: 'abc', algorithm: 'md5', digestEncoding: 'sri' },
      'sri_unsupported_algorithm',
      /sha256|base64/,
    ],
  ] as const)(
    'puts %j on the wire as %s with its recovery hint',
    async (input, reason, hintPattern) => {
      const { error, text } = await wireError(input);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe(reason);
      expect(error.data.recovery.hint).toMatch(hintPattern);
      expect(text).toContain(error.message);
      expect(text).toContain(error.data.recovery.hint);
    },
  );

  it('returns an SRI digest on both surfaces through the contract runner', async () => {
    const result = await runToolContract(hashValueTool, {
      value: 'hello',
      algorithm: 'sha512',
      digestEncoding: 'sri',
    } as never);
    expect(result.structuredContent).toEqual({
      algorithm: 'sha512',
      operation: 'generate',
      digest: SRI_SHA512_HELLO,
      lengthInBytes: 64,
    });
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain(SRI_SHA512_HELLO);
  });
});

/** The error thrown by a call, with its reason, message, and recovery hint. */
const errorOf = (args: unknown) => {
  try {
    run(args);
  } catch (err) {
    return err as { message: string; data: { reason: string; recovery: { hint: string } } };
  }
  throw new Error('expected the call to throw');
};

describe('toolkit_hash_value expected parsing edge cases', () => {
  it('hashes a padding-only base64 value as empty input', async () => {
    const empty = digestOf('sha256', '').toString('hex');
    for (const value of ['', '=', '==']) {
      expect((await run({ value, inputEncoding: 'base64' })).digest).toBe(empty);
    }
  });

  it('reads a hex digest of another algorithm as hex even when its length is valid base64', () => {
    // A sha256 hex digest is 64 characters — exactly the base64 length of a
    // sha384 digest — so a base64 reading would compare garbage bytes and answer
    // matches:false instead of reporting the wrong algorithm.
    const error = errorOf({
      operation: 'compare',
      algorithm: 'sha384',
      value: 'hello',
      expected: digestOf('sha256', 'hello').toString('hex'),
    });
    expect(error.data.reason).toBe('expected_length_mismatch');
    expect(error.message).toContain('64 hex characters');
  });

  it.each([
    ['sha1', digestOf('sha1', 'abc').toString('hex'), 'sha256'],
    ['sha512', digestOf('sha512', 'abc').toString('base64'), 'sha256'],
    ['sha256', digestOf('sha256', 'abc').toString('hex'), 'sha384'],
  ])(
    'names %s in the length-mismatch hint when expected has that digest length',
    (fits, expected, algorithm) => {
      const error = errorOf({ operation: 'compare', algorithm, value: 'abc', expected });
      expect(error.data.reason).toBe('expected_length_mismatch');
      expect(error.data.recovery.hint).toContain(`algorithm ${fits}`);
    },
  );

  it('follows the length-mismatch hint to a match in one hop', async () => {
    const expected = digestOf('sha1', 'abc').toString('hex');
    const hint = errorOf({ operation: 'compare', value: 'abc', expected }).data.recovery.hint;
    const algorithm = /algorithm (\w+)/.exec(hint)?.[1];
    expect((await run({ operation: 'compare', algorithm, value: 'abc', expected })).matches).toBe(
      true,
    );
  });
});

const sri = (algorithm: string, value: string) =>
  `${algorithm}-${digestOf(algorithm, value).toString('base64')}`;

describe('toolkit_hash_value multi-entry SRI expected', () => {
  it.each([
    ['another algorithm first', `${sri('sha384', 'other')} ${sri('sha512', 'hello')}`],
    [
      'a stale entry for the same algorithm first',
      `${sri('sha512', 'other')} ${sri('sha512', 'hello')}`,
    ],
    ['newline and tab separators', `${sri('sha256', 'hello')}\n\t${sri('sha512', 'hello')}`],
  ])('matches when any entry for the algorithm matches (%s)', async (_label, expected) => {
    const result = await run({ algorithm: 'sha512', value: 'hello', expected });
    expect(result).toEqual({ algorithm: 'sha512', operation: 'compare', matches: true });
  });

  it('ignores a matching entry for a different algorithm', async () => {
    const expected = `${sri('sha512', 'other')} ${sri('sha384', 'hello')}`;
    expect((await run({ algorithm: 'sha512', value: 'hello', expected })).matches).toBe(false);
  });

  it('throws expected_algorithm_mismatch when no entry names the algorithm', () => {
    const error = errorOf({
      algorithm: 'sha512',
      value: 'hello',
      expected: `${sri('sha256', 'hello')} ${sri('sha384', 'hello')}`,
    });
    expect(error.data.reason).toBe('expected_algorithm_mismatch');
    expect(error.data.recovery.hint).toMatch(/sha256/);
    expect(error.data.recovery.hint).toMatch(/sha384/);
  });

  it.each([
    ['a non-SRI token', `${sri('sha512', 'hello')} garbage`],
    [
      'a bare hex digest beside an entry',
      `${sri('sha512', 'hello')} ${digestOf('sha512', 'hello').toString('hex')}`,
    ],
    ['an entry with a body outside the base64 alphabet', `${sri('sha512', 'hello')} sha384-###`],
  ])('throws expected_malformed for %s', (_label, expected) => {
    expect(reasonOf({ algorithm: 'sha512', value: 'hello', expected })).toBe('expected_malformed');
  });

  it('keeps expected_length_mismatch for a selected entry of the wrong length', () => {
    const short = `sha512-${digestOf('sha256', 'hello').toString('base64')}`;
    expect(
      reasonOf({
        algorithm: 'sha512',
        value: 'hello',
        expected: `${sri('sha512', 'hello')} ${short}`,
      }),
    ).toBe('expected_length_mismatch');
  });
});
