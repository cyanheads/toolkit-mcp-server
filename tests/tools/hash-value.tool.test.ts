/**
 * @fileoverview Tests for toolkit_hash_value — known-vector digests, constant-time
 * compare, input-encoding handling, and the domain error contract.
 * @module tests/tools/hash-value.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { hashValueTool } from '@/mcp-server/tools/definitions/hash-value.tool.js';

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
