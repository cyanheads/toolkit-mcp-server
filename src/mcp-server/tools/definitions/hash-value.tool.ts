/**
 * @fileoverview toolkit_hash_value — generate a cryptographic digest, or
 * constant-time-compare a value against an expected digest. Pure compute over
 * node:crypto; always-on (no SSRF or info-disclosure surface).
 * @module mcp-server/tools/definitions/hash-value.tool
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

/** Hex digest length (characters) per algorithm — used to pre-validate `expected`. */
const HEX_DIGEST_LENGTH: Record<string, number> = {
  sha256: 64,
  sha512: 128,
  sha1: 40,
  md5: 32,
};

/** Decode `value` into a Buffer per the declared input encoding, validating the encoding. */
function decodeInput(value: string, encoding: 'utf8' | 'hex' | 'base64'): Buffer {
  if (encoding === 'utf8') return Buffer.from(value, 'utf8');
  if (encoding === 'hex') {
    if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
      throw new RangeError('not valid hex');
    }
    return Buffer.from(value, 'hex');
  }
  // base64 — Buffer is lax, so validate the alphabet and round-trip length.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new RangeError('not valid base64');
  const buf = Buffer.from(value, 'base64');
  if (buf.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new RangeError('not valid base64');
  }
  return buf;
}

export const hashValueTool = tool('toolkit_hash_value', {
  title: 'toolkit-mcp-server: hash value',
  description:
    'Generate a cryptographic digest of a value, or verify a value against an expected digest. Set operation to "generate" for a lowercase-hex digest, or "compare" to constant-time-check value against the expected digest — compare is timing-safe and avoids manual string equality checks. Algorithm defaults to sha256; sha512 is also secure, while md5 and sha1 are exposed for checksum and file-integrity compatibility ONLY and must not be used for passwords, signatures, or any security purpose. inputEncoding controls how value and expected are read before hashing (utf8 default, or hex/base64 for raw binary data) so binary blobs need no decode round-trip. The canonical use is matching a download against a vendor-published checksum.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    operation: z
      .enum(['generate', 'compare'])
      .default('generate')
      .describe(
        '"generate" produces a digest; "compare" constant-time-checks value against expected.',
      ),
    value: z
      .string()
      .describe('The data to hash, interpreted per inputEncoding (raw text by default).'),
    algorithm: z
      .enum(['sha256', 'sha512', 'sha1', 'md5'])
      .default('sha256')
      .describe(
        'Digest algorithm. sha256 (default) or sha512 for security; md5/sha1 are checksum/compat only — not for security.',
      ),
    expected: z
      .string()
      .optional()
      .describe(
        'The expected lowercase-hex digest to compare against. Required when operation is "compare".',
      ),
    inputEncoding: z
      .enum(['utf8', 'hex', 'base64'])
      .default('utf8')
      .describe(
        "How value (and expected's pre-image, when relevant) is decoded before hashing: utf8 text, hex, or base64.",
      ),
  }),
  /**
   * The payload key is `value` here and `data` on toolkit_generate_qr; these
   * three name the thing being hashed, never the `expected` digest it is
   * compared against.
   */
  inputAliases: { input: 'value', text: 'value', data: 'value' },
  // Flat object; generate populates digest+lengthInBytes, compare populates matches.
  output: z.object({
    algorithm: z.enum(['sha256', 'sha512', 'sha1', 'md5']).describe('The algorithm used.'),
    operation: z.enum(['generate', 'compare']).describe('The operation performed.'),
    digest: z
      .string()
      .optional()
      .describe('Lowercase-hex digest of value. Present for operation "generate".'),
    matches: z
      .boolean()
      .optional()
      .describe(
        'Constant-time equality of the computed digest against expected. Present for operation "compare".',
      ),
    lengthInBytes: z
      .number()
      .optional()
      .describe(
        'Digest size in bytes (32 for sha256, 64 for sha512, 20 for sha1, 16 for md5). Present for "generate".',
      ),
  }),

  errors: [
    {
      reason: 'missing_expected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'operation is "compare" but no expected digest was supplied.',
      recovery: 'Provide expected (the digest to compare against) when operation is "compare".',
    },
    {
      reason: 'expected_length_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The expected digest length does not match the algorithm, so compare would always fail.',
      recovery:
        "The expected digest length doesn't match the algorithm. Check the algorithm or the expected value.",
    },
    {
      reason: 'invalid_input_encoding',
      code: JsonRpcErrorCode.ValidationError,
      when: 'value is not valid for the declared inputEncoding (e.g. non-hex characters with inputEncoding "hex").',
      recovery:
        'Input is not valid for the declared inputEncoding. Verify the encoding matches the byte representation.',
    },
  ],

  handler(input, ctx) {
    let data: Buffer;
    try {
      data = decodeInput(input.value, input.inputEncoding);
    } catch {
      throw ctx.fail('invalid_input_encoding', `value is not valid ${input.inputEncoding}.`, {
        ...ctx.recoveryFor('invalid_input_encoding'),
      });
    }

    const digest = createHash(input.algorithm).update(data).digest();
    const digestHex = digest.toString('hex');

    if (input.operation === 'compare') {
      if (input.expected === undefined || input.expected.length === 0) {
        throw ctx.fail('missing_expected', undefined, { ...ctx.recoveryFor('missing_expected') });
      }
      const expected = input.expected.trim().toLowerCase();
      const expectedLen = HEX_DIGEST_LENGTH[input.algorithm];
      if (!/^[0-9a-f]+$/.test(expected) || expected.length !== expectedLen) {
        throw ctx.fail(
          'expected_length_mismatch',
          `expected must be a ${expectedLen}-character hex digest for ${input.algorithm}.`,
          {
            recovery: {
              hint: `The expected digest length doesn't match ${input.algorithm}. Check the algorithm or the expected value.`,
            },
          },
        );
      }
      const matches = timingSafeEqual(digest, Buffer.from(expected, 'hex'));
      ctx.log.info('Hash compare', { algorithm: input.algorithm, matches });
      return { algorithm: input.algorithm, operation: input.operation, matches };
    }

    ctx.log.info('Hash generate', { algorithm: input.algorithm });
    return {
      algorithm: input.algorithm,
      operation: input.operation,
      digest: digestHex,
      lengthInBytes: digest.length,
    };
  },

  // Renders whichever fields the operation populated. The linter synthesizes
  // all fields at once, so each is rendered when present.
  format: (result) => {
    const lines = [`**Algorithm:** ${result.algorithm} | **Operation:** ${result.operation}`];
    if (result.digest !== undefined) lines.push(`**Digest:** \`${result.digest}\``);
    if (result.lengthInBytes !== undefined) lines.push(`**Length:** ${result.lengthInBytes} bytes`);
    if (result.matches !== undefined) {
      lines.push(
        `**Matches:** ${result.matches ? 'yes — digest equals expected' : 'no — digest does NOT equal expected'}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
