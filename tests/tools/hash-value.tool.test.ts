/**
 * @fileoverview Tests for toolkit_hash_value — known-vector digests, constant-time
 * compare, omitted-operation resolution, hex/base64/base64url/SRI digests, the
 * checksum-line and prefixed `expected` forms and their parsing time, HMAC via
 * `secret`, input-encoding handling, and the domain error contract.
 * @module tests/tools/hash-value.tool.test
 */

import { createHash, createHmac } from 'node:crypto';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { hashValueTool } from '@/mcp-server/tools/definitions/hash-value.tool.js';
import { readCommonMark } from '../helpers/commonmark.js';

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

/**
 * Parse a tool error envelope off `structuredContent` and the joined text of
 * `content[]` as a CommonMark parse reads it — error text renders Markdown-escaped.
 */
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
    .map((block) => readCommonMark(block.text))
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

/** Digests of "hello", as checksum tools print them. */
const HELLO_SHA256_HEX = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const HELLO_SHA256_BASE64 = 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=';
const HELLO_SHA256_BASE64URL = 'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ';
const HELLO_SHA512_HEX =
  '9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043';
const HELLO_SHA512_BASE64 =
  'm3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==';
const HELLO_SHA1_HEX = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
const HELLO_MD5_HEX = '5d41402abc4b2a76b9719d911017c592';

/** A compare of "hello": its `matches` verdict, or the reason it fails with. */
const verdictOf = async (algorithm: string, expected: string): Promise<boolean | string> => {
  try {
    return (await run({ algorithm, value: 'hello', expected })).matches as boolean;
  } catch (err) {
    return (err as { data: { reason: string } }).data.reason;
  }
};

describe('toolkit_hash_value checksum-line and prefixed expected', () => {
  /**
   * Lines printed for a file holding "hello" by shasum, macOS sha256sum and
   * md5, GNU coreutils 9.12 (sha256sum, md5sum, cksum), OpenSSL 4.1, and
   * LibreSSL 3.3, exactly as each tool writes them.
   */
  it.each([
    ['shasum -a 256 / sha256sum', 'sha256', `${HELLO_SHA256_HEX}  hello.txt`],
    ['sha256sum -b / openssl dgst -r', 'sha256', `${HELLO_SHA256_HEX} *hello.txt`],
    ['shasum -U', 'sha256', `${HELLO_SHA256_HEX} Uhello.txt`],
    ['shasum --tag / sha256sum --tag', 'sha256', `SHA256 (hello.txt) = ${HELLO_SHA256_HEX}`],
    ['cksum --base64', 'sha256', `SHA256 (hello.txt) = ${HELLO_SHA256_BASE64}`],
    ['cksum -a sha512 --base64', 'sha512', `SHA512 (hello.txt) = ${HELLO_SHA512_BASE64}`],
    ['GNU sha256sum, escaped name', 'sha256', `\\${HELLO_SHA256_HEX}  back\\\\slash.txt`],
    [
      'GNU sha256sum --tag, escaped name',
      'sha256',
      `\\SHA256 (back\\\\slash.txt) = ${HELLO_SHA256_HEX}`,
    ],
    ['sha256sum, name with spaces', 'sha256', `${HELLO_SHA256_HEX}  my file (1) = b.txt`],
    [
      'sha256sum --tag, name with "(1)" and " = "',
      'sha256',
      `SHA256 (my file (1) = b.txt) = ${HELLO_SHA256_HEX}`,
    ],
    ['md5', 'md5', `MD5 (hello.txt) = ${HELLO_MD5_HEX}`],
    ['md5 -r', 'md5', `${HELLO_MD5_HEX} hello.txt`],
    ['md5sum', 'md5', `${HELLO_MD5_HEX}  hello.txt`],
    ['shasum -a 1', 'sha1', `${HELLO_SHA1_HEX}  hello.txt`],
    ['OpenSSL dgst -sha256', 'sha256', `SHA2-256(hello.txt)= ${HELLO_SHA256_HEX}`],
    ['OpenSSL dgst -sha512', 'sha512', `SHA2-512(hello.txt)= ${HELLO_SHA512_HEX}`],
    ['OpenSSL dgst -md5', 'md5', `MD5(hello.txt)= ${HELLO_MD5_HEX}`],
    ['OpenSSL dgst -sha1', 'sha1', `SHA1(hello.txt)= ${HELLO_SHA1_HEX}`],
    ['LibreSSL dgst -sha256', 'sha256', `SHA256(hello.txt)= ${HELLO_SHA256_HEX}`],
  ])('matches a %s line', async (_label, algorithm, expected) => {
    const result = await run({ algorithm, value: 'hello', expected });
    expect(result).toEqual({ algorithm, operation: 'compare', matches: true });
  });

  it.each([
    ['a tab before the file name', `${HELLO_SHA256_HEX}\thello.txt`],
    ['an uppercase hex digest', `${HELLO_SHA256_HEX.toUpperCase()}  hello.txt`],
    ['a trailing line break', `${HELLO_SHA256_HEX}  hello.txt\r\n`],
    ['a lowercase tag', `sha256 (hello.txt) = ${HELLO_SHA256_HEX}`],
    ['a tag with no spaces', `SHA256(hello.txt)=${HELLO_SHA256_HEX}`],
    ['a tag over a base64url digest', `SHA256 (hello.txt) = ${HELLO_SHA256_BASE64URL}`],
    ['an OCI or GitHub release digest', `sha256:${HELLO_SHA256_HEX}`],
    ['an uppercase prefix', `SHA256:${HELLO_SHA256_HEX}`],
    ['a space after the colon', `sha256: ${HELLO_SHA256_HEX}`],
    ['a tab after the colon', `sha256:\t${HELLO_SHA256_HEX}`],
    ['a signature-header prefix', `sha256=${HELLO_SHA256_HEX}`],
    ['a prefixed base64 digest', `sha256:${HELLO_SHA256_BASE64}`],
    ['a prefixed base64url digest', `sha256=${HELLO_SHA256_BASE64URL}`],
    ['a bare base64url digest', HELLO_SHA256_BASE64URL],
    ['a padded base64url digest', `${HELLO_SHA256_BASE64URL}=`],
    ['an uppercase SRI prefix', `SHA256-${HELLO_SHA256_BASE64}`],
    ['a mixed-case SRI prefix', `Sha256-${HELLO_SHA256_BASE64}`],
  ])('matches sha256("hello") written with %s', async (_label, expected) => {
    expect(await verdictOf('sha256', expected)).toBe(true);
  });

  it.each([
    ['sha1', `sha1=${HELLO_SHA1_HEX}`],
    ['md5', `md5:${HELLO_MD5_HEX}`],
    ['sha512', `SHA512:${HELLO_SHA512_HEX}`],
  ])('matches a %s prefixed digest under its own algorithm', async (algorithm, expected) => {
    expect(await verdictOf(algorithm, expected)).toBe(true);
  });

  it('matches a bare base64url digest holding "_"', async () => {
    // sha256("v1") is O_wm…iP4 in base64url, O/wm…iP4 in standard base64.
    const result = await run({
      value: 'v1',
      expected: 'O_wmlZTvZJIo6adLqwDwQu_JHVrMb77jGjgugNQjiP4',
    });
    expect(result).toEqual({ algorithm: 'sha256', operation: 'compare', matches: true });
  });

  it.each([
    ['an unpadded base64 digest', 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ', 'hello'],
    // sha256("v0") has no "-" or "_" in base64url, so it reads the same in both alphabets.
    ['a base64url digest with no "-" or "_"', 'AnDaTarFFPML7OV4ioete4APWUdtDX5vcNS2H7xPXp4', 'v0'],
  ])('keeps matching %s', async (_label, expected, value) => {
    expect((await run({ value, expected })).matches).toBe(true);
  });

  it.each([
    ['a checksum line', `${digestOf('sha256', 'world').toString('hex')}  hello.txt`],
    ['a tagged line', `SHA256 (hello.txt) = ${digestOf('sha256', 'world').toString('hex')}`],
    ['a prefixed digest', `sha256:${digestOf('sha256', 'world').toString('hex')}`],
    ['a bare base64url digest', digestOf('sha256', 'world').toString('base64url')],
  ])('reports matches:false for %s of other data', async (_label, expected) => {
    expect(await verdictOf('sha256', expected)).toBe(false);
  });

  it.each([
    ['a prefix', `sha512:${HELLO_SHA512_HEX}`, 'sha512'],
    ['a BSD tag', `MD5 (f) = ${HELLO_MD5_HEX}`, 'md5'],
    ['an OpenSSL SHA2- tag', `SHA2-512(hello.txt)= ${HELLO_SHA512_HEX}`, 'sha512'],
    ['a signature-header prefix', `sha1=${HELLO_SHA1_HEX}`, 'sha1'],
  ])(
    'throws expected_algorithm_mismatch for %s naming another algorithm, and the hint leads to a match',
    async (_label, expected, named) => {
      const error = errorOf({ algorithm: 'sha256', value: 'hello', expected });
      expect(error.data.reason).toBe('expected_algorithm_mismatch');
      expect(error.message).toContain(named);
      expect(error.data.recovery.hint).toContain(`algorithm ${named}`);
      const algorithm = /algorithm (\w+)/.exec(error.data.recovery.hint)?.[1];
      expect(await verdictOf(algorithm as string, expected)).toBe(true);
    },
  );

  it('names the algorithm a mislabeled digest belongs to only when it carries no label', async () => {
    // Unlabeled: the hint points at the algorithm the length fits, and following it matches.
    const unlabeled = errorOf({ value: 'hello', expected: `${HELLO_SHA1_HEX}  hello.txt` });
    expect(unlabeled.data.reason).toBe('expected_length_mismatch');
    expect(unlabeled.data.recovery.hint).toContain('algorithm sha1');
    expect(await verdictOf('sha1', `${HELLO_SHA1_HEX}  hello.txt`)).toBe(true);
    // Labeled sha256 but sha1-sized: retrying with sha1 would contradict the label.
    for (const expected of [`sha256:${HELLO_SHA1_HEX}`, `SHA256 (f) = ${HELLO_SHA1_HEX}`]) {
      const labeled = errorOf({ value: 'hello', expected });
      expect(labeled.data.reason).toBe('expected_length_mismatch');
      expect(labeled.data.recovery.hint).not.toContain('algorithm sha1');
    }
  });

  it.each([
    ['LF', `${HELLO_SHA256_HEX}  hello.txt\n${HELLO_SHA256_HEX}  other.txt`],
    ['CRLF', `${HELLO_SHA256_HEX}  hello.txt\r\n${HELLO_SHA256_HEX}  other.txt`],
    ['tagged', `SHA256 (a) = ${HELLO_SHA256_HEX}\nSHA256 (b) = ${HELLO_SHA256_HEX}`],
  ])(
    'throws expected_malformed for a multi-line (%s) checksum file, pointing at its single line',
    async (_label, expected) => {
      const { error, text } = await wireError({ value: 'hello', expected });
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('expected_malformed');
      expect(error.message).toMatch(/line/);
      expect(error.data.recovery.hint).toMatch(/one line|single line|the line/);
      expect(text).toContain(error.message);
      expect(text).toContain(error.data.recovery.hint);
    },
  );

  it('still reads a multi-line SRI value as SRI', async () => {
    const expected = `${sri('sha256', 'hello')}\n${sri('sha512', 'hello')}`;
    expect(await verdictOf('sha512', expected)).toBe(true);
  });

  it.each([
    ['both base64 alphabets at once', 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmC-'],
    ['an unsupported tag', `SHA224 (hello.txt) = ${HELLO_SHA256_HEX}`],
    ['an unsupported prefix', `sha3-256:${HELLO_SHA256_HEX}`],
    ['a prefix with no digest', 'sha256:'],
    ['a tag with no digest', 'SHA256 (hello.txt) = '],
    ['a prefixed digest with trailing words', `sha256:${HELLO_SHA256_HEX} hello.txt`],
    ['a tagged line with an unreadable digest', 'SHA256 (hello.txt) = not-a-digest!'],
    ['a checksum line with no file name', `\\${HELLO_SHA256_HEX}`],
  ])('throws expected_malformed for %s', async (_label, expected) => {
    expect(await verdictOf('sha256', expected)).toBe('expected_malformed');
  });

  it.each([
    // A short hex digest then a name now reads as a checksum line of the wrong length.
    ['deadbeef file', 'expected_length_mismatch'],
    // The `sha1=` prefix names sha1, which outranks the body's length.
    ['sha1==', 'expected_algorithm_mismatch'],
  ])('fails %j as %s', async (expected, reason) => {
    expect(await verdictOf('sha256', expected)).toBe(reason);
  });

  /** The `expected_malformed` contract recovery, as a caller reads it on the wire. */
  const MALFORMED_RECOVERY =
    'Pass expected as one digest: hex, base64, or base64url, SRI entries such as sha512-<base64>, one line of a checksum file, or a prefixed digest such as sha256:<hex>.';
  const HELLO_SHA256_HALVES = `${HELLO_SHA256_HEX.slice(0, 32)} ${HELLO_SHA256_HEX.slice(32)}`;

  it.each([
    ['in 8-character groups', 'sha256', HELLO_SHA256_HEX.match(/.{8}/g)?.join(' ') as string],
    ['in two 32-character halves', 'sha256', HELLO_SHA256_HALVES],
    // The first half has an md5 digest's length; the second half is still no file name.
    ['in two 32-character halves, under md5', 'md5', HELLO_SHA256_HALVES],
  ])(
    'refuses hex split %s as expected_malformed on both surfaces, never as a checksum line',
    async (_label, algorithm, expected) => {
      const { error, text } = await wireError({ algorithm, value: 'hello', expected });
      expect(error).toEqual({
        code: JsonRpcErrorCode.ValidationError,
        message: `expected is not a ${algorithm} digest in any form this tool reads (hex, base64, base64url, SRI, a checksum line, or a prefixed digest).`,
        data: { reason: 'expected_malformed', recovery: { hint: MALFORMED_RECOVERY } },
      });
      expect(text).toBe(
        [
          `Error: ${error.message}`,
          `Recovery: ${MALFORMED_RECOVERY}`,
          '(reason expected_malformed)',
        ].join('\n\n'),
      );
    },
  );

  it('refuses a checksum line whose file name is only hex digits, unless a mode marker precedes it', async () => {
    expect(await verdictOf('sha256', `${HELLO_SHA256_HEX}  cafe`)).toBe('expected_malformed');
    expect(await verdictOf('sha256', `${HELLO_SHA256_HEX} *cafe`)).toBe(true);
    expect(await verdictOf('sha256', `${HELLO_SHA256_HEX}  cafe.iso`)).toBe(true);
  });

  it.each([
    [
      { value: 'hello', expected: `sha512:${HELLO_SHA512_HEX}` },
      'expected_algorithm_mismatch',
      /sha512/,
    ],
    [{ value: 'hello', expected: 'not a digest!' }, 'expected_malformed', /hex|base64/i],
  ] as const)(
    'puts %j on the wire as %s with its recovery hint',
    async (input, reason, hintPattern) => {
      const { error, text } = await wireError(input);
      expect(error.data.reason).toBe(reason);
      expect(error.data.recovery.hint).toMatch(hintPattern);
      expect(text).toContain(error.message);
      expect(text).toContain(error.data.recovery.hint);
    },
  );

  it('returns a checksum-line compare on both surfaces', async () => {
    const result = await runToolContract(hashValueTool, {
      value: 'hello',
      expected: `SHA256 (hello.txt) = ${HELLO_SHA256_HEX}`,
    } as never);
    expect(result.structuredContent).toEqual({
      algorithm: 'sha256',
      operation: 'compare',
      matches: true,
    });
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => readCommonMark(block.text))
      .join('\n');
    expect(text).toBe(
      '⟨strong⟩Algorithm:⟨/strong⟩ sha256 | ⟨strong⟩Operation:⟨/strong⟩ compare\n⟨strong⟩Matches:⟨/strong⟩ yes — digest equals expected',
    );
  });
});

/** CPU time (ms) of one `fn()` call: the least of three samples, each repeating `fn` until it has used ~10 ms. */
function cpuMsPerCall(fn: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 3; sample++) {
    const start = process.threadCpuUsage();
    let calls = 0;
    let usedMs = 0;
    while (usedMs < 10) {
      fn();
      calls++;
      const { user, system } = process.threadCpuUsage(start);
      usedMs = (user + system) / 1000;
    }
    best = Math.min(best, usedMs / calls);
  }
  return best;
}

/** Doubling sizes from 5,000 to 320,000 characters, a 64× span. */
const SIZES = Array.from({ length: 7 }, (_, i) => 5_000 * 2 ** i);

/** `expected` values of about `n` characters, each built to drive one reading of `expected` into its worst case. */
const EXPECTED_SHAPES: [string, (n: number) => string][] = [
  [
    'a tagged line repeating ")=" and digest characters before a refused end',
    (n) => `SHA256 (${')=a'.repeat(n / 3)} !`,
  ],
  [
    'a tagged line repeating ")= " and digest characters before a refused end',
    (n) => `SHA256 (${')= a'.repeat(n / 4)} !`,
  ],
  ['a tagged line repeating ") = " with no digest', (n) => `SHA256 (${') = '.repeat(n / 4)}!`],
  ['a tagged line of nested openers', (n) => `SHA2-256(${'('.repeat(n)}= x`],
  [
    'a tagged line with a blank run before a refused character',
    (n) => `SHA256 (f) =${' '.repeat(n)}\f!`,
  ],
  [
    'a hex run then a blank run before a refused character',
    (n) => `${'a'.repeat(n / 2)}${' \t'.repeat(n / 4)}\f`,
  ],
  ['a hex run with no blank', (n) => `\\${'a'.repeat(n)}!`],
  ['hex in 8-character groups', (n) => '2cf24dba '.repeat(n / 9)],
  ['one-character hex groups', (n) => 'a '.repeat(n / 2)],
  ['two long hex halves', (n) => `${'a'.repeat(n / 2)} ${'b'.repeat(n / 2)}`],
  ['hex groups ending in a non-hex token', (n) => `${'ab \t'.repeat(n / 4)}x`],
  ['a prefix then a blank run before a refused character', (n) => `sha256:${' '.repeat(n)}\f!`],
  ['a prefix then a digest run before trailing words', (n) => `sha256=${'a'.repeat(n)} !`],
  ['many SRI entries', (n) => 'sha256-AAAA '.repeat(n / 12)],
  ['a long bare base64 run', (n) => 'A+'.repeat(n / 2)],
  ['a long bare base64url run', (n) => 'A-'.repeat(n / 2)],
  ['one long line ending in a break', (n) => `${'x '.repeat(n / 2)}\ny`],
  ['line breaks throughout', (n) => `${HELLO_SHA256_HEX}${'  \r\n'.repeat(n / 4)}hello.txt`],
  [
    'a tagged line holding a long line-break run',
    (n) => `SHA256 (${'  \r\n'.repeat(n / 4)}) = ${HELLO_SHA256_HEX}`,
  ],
];

describe('toolkit_hash_value expected parsing CPU time', () => {
  it.each(EXPECTED_SHAPES)(
    'stays linear in CPU time on %s',
    (_label, shape) => {
      const ctx = createMockContext({ errors: hashValueTool.errors });
      const perCall: number[] = [];
      for (const n of SIZES) {
        const input = hashValueTool.input.parse({
          operation: 'compare',
          value: 'hello',
          expected: shape(n),
        });
        const ms = cpuMsPerCall(() => {
          try {
            hashValueTool.handler(input, ctx);
          } catch {
            // Every shape is unreadable or mismatched; only the time to say so is measured.
          }
        });
        // ≤1 µs per character: a linear reading sits far below it at every size,
        // and a quadratic one crosses it before the doubling reaches the largest size.
        expect(ms).toBeLessThan(n / 1000);
        perCall.push(ms);
      }
      expect((perCall.at(-1) as number) / (perCall[0] as number)).toBeLessThan(256);
    },
    60_000,
  );
});

/** GitHub's published webhook test vector ("Validating webhook deliveries"). */
const GITHUB_SECRET = "It's a Secret to Everybody";
const GITHUB_PAYLOAD = 'Hello, World!';
const GITHUB_SIGNATURE = '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

/** RFC 7515 Appendix A.1: the HS256 JWS Signing Input, the JWK `k` it is keyed with, and its signature. */
const JWS_SIGNING_INPUT =
  'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ';
const JWK_K =
  'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow';
const JWS_SIGNATURE = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

/** A secret no other fixture contains, so finding it anywhere is a leak. */
const CANARY_SECRET = 'zz-CANARY-SECRET-9f3c';

describe('toolkit_hash_value HMAC via secret', () => {
  it('verifies the GitHub X-Hub-Signature-256 vector as sent in the header', async () => {
    const result = await run({
      operation: 'compare',
      algorithm: 'sha256',
      secret: GITHUB_SECRET,
      value: GITHUB_PAYLOAD,
      expected: `sha256=${GITHUB_SIGNATURE}`,
    });
    expect(result).toEqual({
      algorithm: 'sha256',
      operation: 'compare',
      hmac: true,
      matches: true,
    });
  });

  it('generates the GitHub signature as hex', async () => {
    const result = await run({ secret: GITHUB_SECRET, value: GITHUB_PAYLOAD });
    expect(result).toEqual({
      algorithm: 'sha256',
      operation: 'generate',
      hmac: true,
      digest: GITHUB_SIGNATURE,
      lengthInBytes: 32,
    });
  });

  it('verifies the RFC 7515 A.1 HS256 signature with the JWK k as base64url', async () => {
    const result = await run({
      secret: JWK_K,
      secretEncoding: 'base64url',
      value: JWS_SIGNING_INPUT,
      expected: JWS_SIGNATURE,
    });
    expect(result).toEqual({
      algorithm: 'sha256',
      operation: 'compare',
      hmac: true,
      matches: true,
    });
  });

  it('generates the RFC 7515 A.1 signature as base64url', async () => {
    const result = await run({
      secret: JWK_K,
      secretEncoding: 'base64url',
      value: JWS_SIGNING_INPUT,
      digestEncoding: 'base64url',
    });
    expect(result).toMatchObject({ hmac: true, digest: JWS_SIGNATURE, lengthInBytes: 32 });
  });

  it.each([
    [
      'hex',
      '0323354b2b0fa5bc837e0665777ba68f5ab328e6f054c928a90f84b2d2502ebfd3fb5a92d20647ef968ab4c377623d223d2e2172052e4f08c0cd9af567d080a3',
    ],
    [
      'base64',
      'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ+EstJQLr/T+1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow==',
    ],
  ] as const)('reads the same JWK key bytes written as %s', async (secretEncoding, secret) => {
    const result = await run({
      secret,
      secretEncoding,
      value: JWS_SIGNING_INPUT,
      expected: JWS_SIGNATURE,
    });
    expect(result.matches).toBe(true);
  });

  it.each([
    ['md5', '43e83d30cb1dff0c1000065b06487708'],
    ['sha1', '01dc10d0c83e72ed246219cdd91669667fe2ca59'],
    [
      'sha384',
      '8ae941e23ce94331d5a5986b762bbdb2039fec41c133145da82908f381ba612379307f45738b252be379438ef60839c2',
    ],
    [
      'sha512',
      '11ed355a617e98134e842012a7944ccf59c10256cb182357bd7e3a42013ff07c376f8c14cf5cc1923da20b51d64256b2fb8ebbf100aa67a61326f61fea8111bc',
    ],
  ])('computes HMAC-%s', async (algorithm, hex) => {
    const generated = await run({ algorithm, secret: GITHUB_SECRET, value: GITHUB_PAYLOAD });
    expect(generated).toMatchObject({ hmac: true, digest: hex, lengthInBytes: hex.length / 2 });
    const compared = await run({
      algorithm,
      secret: GITHUB_SECRET,
      value: GITHUB_PAYLOAD,
      expected: hex,
    });
    expect(compared.matches).toBe(true);
  });

  it('verifies a legacy X-Hub-Signature sha1= header', async () => {
    const result = await run({
      algorithm: 'sha1',
      secret: GITHUB_SECRET,
      value: GITHUB_PAYLOAD,
      expected: 'sha1=01dc10d0c83e72ed246219cdd91669667fe2ca59',
    });
    expect(result).toEqual({ algorithm: 'sha1', operation: 'compare', hmac: true, matches: true });
  });

  it('reports matches:false for the right signature over a tampered payload', async () => {
    const result = await run({
      secret: GITHUB_SECRET,
      value: `${GITHUB_PAYLOAD} `,
      expected: `sha256=${GITHUB_SIGNATURE}`,
    });
    expect(result).toEqual({
      algorithm: 'sha256',
      operation: 'compare',
      hmac: true,
      matches: false,
    });
  });

  it('never matches a plain digest against an HMAC signature', async () => {
    const result = await run({ value: GITHUB_PAYLOAD, expected: `sha256=${GITHUB_SIGNATURE}` });
    expect(result).toEqual({ algorithm: 'sha256', operation: 'compare', matches: false });
  });

  it('treats an empty secret as absent, as a form client sends an untouched field', async () => {
    expect(await run({ value: 'hello', secret: '' })).toEqual({
      algorithm: 'sha256',
      operation: 'generate',
      digest: HELLO_SHA256_HEX,
      lengthInBytes: 32,
    });
    expect(await run({ value: 'hello', secret: '', expected: HELLO_SHA256_HEX })).toEqual({
      algorithm: 'sha256',
      operation: 'compare',
      matches: true,
    });
  });

  it('ignores secretEncoding when no secret is sent', async () => {
    expect(await run({ value: 'hello', secretEncoding: 'hex' })).toEqual({
      algorithm: 'sha256',
      operation: 'generate',
      digest: HELLO_SHA256_HEX,
      lengthInBytes: 32,
    });
  });

  it('uses a secret exactly as written, never trimmed', async () => {
    const padded = await run({ value: GITHUB_PAYLOAD, secret: ` ${GITHUB_SECRET} ` });
    expect(padded.digest).toBe(
      createHmac('sha256', ` ${GITHUB_SECRET} `).update(GITHUB_PAYLOAD).digest('hex'),
    );
    expect(padded.digest).not.toBe(GITHUB_SIGNATURE);
  });

  it('keys an HMAC with zero bytes when the secret decodes to none', async () => {
    const result = await run({ value: GITHUB_PAYLOAD, secret: '=', secretEncoding: 'base64' });
    expect(result).toMatchObject({
      hmac: true,
      digest: createHmac('sha256', Buffer.alloc(0)).update(GITHUB_PAYLOAD).digest('hex'),
    });
  });

  it('hashes binary input under an HMAC', async () => {
    const result = await run({
      value: Buffer.from(GITHUB_PAYLOAD).toString('hex'),
      inputEncoding: 'hex',
      secret: GITHUB_SECRET,
    });
    expect(result.digest).toBe(GITHUB_SIGNATURE);
  });

  it.each([
    ['hex', `${CANARY_SECRET}`],
    ['hex', 'abc'],
    ['base64', `${CANARY_SECRET}-_`],
    ['base64url', 'ab+/'],
  ] as const)(
    'throws invalid_secret_encoding for a secret that is not %s (%j)',
    (secretEncoding, secret) => {
      expect(reasonOf({ value: 'x', secret, secretEncoding })).toBe('invalid_secret_encoding');
    },
  );

  it('throws sri_with_secret for an SRI digest of an HMAC', () => {
    expect(reasonOf({ value: 'x', secret: GITHUB_SECRET, digestEncoding: 'sri' })).toBe(
      'sri_with_secret',
    );
    // md5 is not an SRI algorithm either; the secret is reported first, since its hint fixes both.
    expect(
      reasonOf({ value: 'x', algorithm: 'md5', secret: GITHUB_SECRET, digestEncoding: 'sri' }),
    ).toBe('sri_with_secret');
  });

  it('leaves calls without a secret unchanged, SRI included', async () => {
    expect(await run({ value: 'hello', algorithm: 'sha512', digestEncoding: 'sri' })).toEqual({
      algorithm: 'sha512',
      operation: 'generate',
      digest: SRI_SHA512_HELLO,
      lengthInBytes: 64,
    });
  });

  it.each([
    [
      { value: 'x', secret: CANARY_SECRET, secretEncoding: 'hex' },
      'invalid_secret_encoding',
      /secretEncoding/,
    ],
    [
      { value: 'x', secret: CANARY_SECRET, digestEncoding: 'sri' },
      'sri_with_secret',
      /digestEncoding/,
    ],
  ] as const)(
    'puts %j on the wire as %s with its recovery hint and never the secret',
    async (input, reason, hintPattern) => {
      const result = await runToolContract(hashValueTool, input as never);
      const { error, text } = await wireError(input);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe(reason);
      expect(error.data.recovery.hint).toMatch(hintPattern);
      expect(text).toContain(error.message);
      expect(text).toContain(error.data.recovery.hint);
      expect(JSON.stringify(result)).not.toContain(CANARY_SECRET);
    },
  );

  it('keeps the secret off both success surfaces and out of ctx.log', async () => {
    const ctx = createMockContext({ errors: hashValueTool.errors });
    for (const args of [
      { value: 'x', secret: CANARY_SECRET },
      { value: 'x', secret: CANARY_SECRET, expected: '0'.repeat(64) },
    ]) {
      const result = await runToolContract(hashValueTool, args as never);
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).not.toContain(CANARY_SECRET);
      await hashValueTool.handler(hashValueTool.input.parse(args), ctx);
    }
    const failing = hashValueTool.input.parse({
      value: 'x',
      secret: CANARY_SECRET,
      secretEncoding: 'hex',
    });
    expect(() => hashValueTool.handler(failing, ctx)).toThrow();
    const log = ctx.log as MockContextLogger;
    expect(log.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(log.calls)).not.toContain(CANARY_SECRET);
  });

  it('accepts the secret only as secret, never under an alias', () => {
    const result = hashValueTool.input.safeParse({ value: 'x', key: GITHUB_SECRET });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('key');
    expect(Object.values(hashValueTool.inputAliases ?? {})).not.toContain('secret');
  });

  it('advertises secret as optional and secretEncoding defaulting to utf8', () => {
    const schema = z.toJSONSchema(hashValueTool.input) as {
      properties: Record<string, { default?: unknown; enum?: unknown[] }>;
      required?: string[];
    };
    expect(schema.required ?? []).not.toContain('secret');
    expect(schema.properties.secretEncoding?.default).toBe('utf8');
    expect(schema.properties.secretEncoding?.enum).toEqual(['utf8', 'hex', 'base64', 'base64url']);
    expect(schema.properties.digestEncoding?.enum).toEqual(['hex', 'base64', 'base64url', 'sri']);
  });

  it('returns an HMAC compare on both surfaces', async () => {
    const result = await runToolContract(hashValueTool, {
      secret: GITHUB_SECRET,
      value: GITHUB_PAYLOAD,
      expected: `sha256=${GITHUB_SIGNATURE}`,
    } as never);
    expect(result.structuredContent).toEqual({
      algorithm: 'sha256',
      operation: 'compare',
      hmac: true,
      matches: true,
    });
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => readCommonMark(block.text))
      .join('\n');
    expect(text).toBe(
      '⟨strong⟩Algorithm:⟨/strong⟩ sha256 | ⟨strong⟩Operation:⟨/strong⟩ compare | ⟨strong⟩HMAC:⟨/strong⟩ yes, keyed with secret\n⟨strong⟩Matches:⟨/strong⟩ yes — digest equals expected',
    );
  });

  it('returns an HMAC digest on both surfaces', async () => {
    const result = await runToolContract(hashValueTool, {
      secret: JWK_K,
      secretEncoding: 'base64url',
      value: JWS_SIGNING_INPUT,
      digestEncoding: 'base64url',
    } as never);
    expect(result.structuredContent).toEqual({
      algorithm: 'sha256',
      operation: 'generate',
      hmac: true,
      digest: JWS_SIGNATURE,
      lengthInBytes: 32,
    });
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => readCommonMark(block.text))
      .join('\n');
    expect(text).toBe(
      `⟨strong⟩Algorithm:⟨/strong⟩ sha256 | ⟨strong⟩Operation:⟨/strong⟩ generate | ⟨strong⟩HMAC:⟨/strong⟩ yes, keyed with secret\n⟨strong⟩Digest:⟨/strong⟩ ⟨code_inline:${JWS_SIGNATURE}⟩\n⟨strong⟩Length:⟨/strong⟩ 32 bytes`,
    );
  });
});

describe('toolkit_hash_value base64url digestEncoding', () => {
  it('generates an unpadded URL-safe digest', async () => {
    const result = await run({ value: 'hello', digestEncoding: 'base64url' });
    expect(result).toEqual({
      algorithm: 'sha256',
      operation: 'generate',
      digest: HELLO_SHA256_BASE64URL,
      lengthInBytes: 32,
    });
  });

  it.each(['sha256', 'sha384', 'sha512', 'sha1', 'md5'] as const)(
    'round-trips a %s base64url digest through compare',
    async (algorithm) => {
      const generated = await run({ value: 'payload', algorithm, digestEncoding: 'base64url' });
      expect(generated.digest).toBe(digestOf(algorithm, 'payload').toString('base64url'));
      expect(generated.digest).not.toMatch(/[+/=]/);
      const compared = await run({ value: 'payload', algorithm, expected: generated.digest });
      expect(compared.matches).toBe(true);
    },
  );
});
