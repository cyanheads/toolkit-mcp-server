/**
 * @fileoverview toolkit_hash_value — generate a cryptographic digest, or
 * constant-time-compare a value against an expected digest. Pure compute over
 * node:crypto; always-on (no SSRF or info-disclosure surface).
 * @module mcp-server/tools/definitions/hash-value.tool
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

const ALGORITHMS = ['sha256', 'sha384', 'sha512', 'sha1', 'md5'] as const;
type Algorithm = (typeof ALGORITHMS)[number];

/** Digest size in bytes per algorithm — sizes every accepted `expected` shape. */
const DIGEST_BYTES: Record<Algorithm, number> = {
  sha256: 32,
  sha384: 48,
  sha512: 64,
  sha1: 20,
  md5: 16,
};

/** The algorithms Subresource Integrity defines; `<algorithm>-<base64>` exists only for these. */
const SRI_ALGORITHMS: ReadonlySet<Algorithm> = new Set(['sha256', 'sha384', 'sha512']);

/** Strict standard base64: alphabet check plus a round-trip, since Buffer decodes leniently. */
function decodeBase64(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return;
  const buf = Buffer.from(value, 'base64');
  return buf.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '') ? buf : undefined;
}

/** Decode `value` into a Buffer per the declared input encoding, validating the encoding. */
function decodeInput(value: string, encoding: 'utf8' | 'hex' | 'base64'): Buffer {
  if (encoding === 'utf8') return Buffer.from(value, 'utf8');
  if (encoding === 'hex') {
    if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
      throw new RangeError('not valid hex');
    }
    return Buffer.from(value, 'hex');
  }
  const buf = decodeBase64(value);
  if (!buf) throw new RangeError('not valid base64');
  return buf;
}

/**
 * How an `expected` digest was read. `digests` holds every candidate at the
 * algorithm's length (several when an SRI value carries more than one entry
 * for it); `malformed`, `lengthMismatch`, and `sriAlgorithm` name the three
 * ways it can fail to be read. `found` describes a mismatched length in the
 * shape's own unit, for the error message; `fits` names the algorithm an
 * unprefixed digest of that length belongs to, when there is one.
 */
type ParsedExpected =
  | { kind: 'digests'; digests: Buffer[] }
  | { kind: 'malformed' }
  | { kind: 'lengthMismatch'; found: string; fits?: Algorithm | undefined }
  | { kind: 'sriAlgorithm'; named: Algorithm[] };

/** The supported algorithm whose digest is `size` bytes, if any. */
const algorithmOfSize = (size: number): Algorithm | undefined =>
  ALGORITHMS.find((candidate) => DIGEST_BYTES[candidate] === size);

/** One SRI entry: `<algorithm>-<base64>`, for the algorithms SRI defines. */
const SRI_ENTRY = /^(sha256|sha384|sha512)-(.+)$/;

/**
 * Read `expected` as hex, bare base64, or SRI, scoped to the declared
 * algorithm's digest length. A string of hex digits is always read as hex,
 * so a hex digest of the wrong algorithm is a length mismatch even when its
 * length happens to be valid base64 for this one (64 hex characters are the
 * base64 length of a sha384 digest). Any other string in the base64 alphabet
 * is read as base64. A value holding an SRI entry, or several whitespace-
 * separated tokens, is read as SRI: every token must be an entry, the entries
 * naming `algorithm` are the candidates, and entries for other algorithms are
 * skipped, as SRI metadata allows.
 */
function parseExpected(expected: string, algorithm: Algorithm): ParsedExpected {
  const bytes = DIGEST_BYTES[algorithm];
  const tokens = expected.split(/\s+/);
  if (tokens.length > 1 || SRI_ENTRY.test(expected)) {
    const entries: { named: Algorithm; body: Buffer }[] = [];
    for (const token of tokens) {
      const match = SRI_ENTRY.exec(token);
      const body = match && decodeBase64(match[2] as string);
      if (!match || !body) return { kind: 'malformed' };
      entries.push({ named: match[1] as Algorithm, body });
    }
    const selected = entries.filter((entry) => entry.named === algorithm);
    if (selected.length === 0) {
      return { kind: 'sriAlgorithm', named: [...new Set(entries.map((entry) => entry.named))] };
    }
    const wrong = selected.find((entry) => entry.body.length !== bytes);
    if (wrong)
      return { kind: 'lengthMismatch', found: `an SRI digest of ${wrong.body.length} bytes` };
    return { kind: 'digests', digests: selected.map((entry) => entry.body) };
  }
  if (/^[0-9a-fA-F]+$/.test(expected)) {
    return expected.length === bytes * 2
      ? { kind: 'digests', digests: [Buffer.from(expected, 'hex')] }
      : {
          kind: 'lengthMismatch',
          found: `${expected.length} hex characters`,
          fits: algorithmOfSize(expected.length / 2),
        };
  }
  const base64 = decodeBase64(expected);
  if (!base64) return { kind: 'malformed' };
  return base64.length === bytes
    ? { kind: 'digests', digests: [base64] }
    : {
        kind: 'lengthMismatch',
        found: `base64 of ${base64.length} bytes`,
        fits: algorithmOfSize(base64.length),
      };
}

export const hashValueTool = tool('toolkit_hash_value', {
  title: 'toolkit-mcp-server: hash value',
  description:
    'Generate a cryptographic digest of a value, or verify a value against an expected digest. Set operation to "generate" for a digest, or "compare" to constant-time-check value against the expected digest — compare is timing-safe and avoids manual string equality checks. Omitting operation compares when expected is supplied and generates otherwise. Algorithm defaults to sha256; sha384 and sha512 are also secure, while md5 and sha1 are exposed for checksum and file-integrity compatibility ONLY and must not be used for passwords, signatures, or any security purpose. digestEncoding selects the generated digest form: lowercase hex (default), base64, or sri (<algorithm>-<base64>, the npm lockfile integrity and Subresource Integrity form, sha256/sha384/sha512 only). expected is accepted as hex, base64, or SRI, recognized by its shape at the algorithm\'s digest length, so a published checksum can be pasted as-is; an SRI value may hold several space-separated entries, as an npm integrity field can, and matches when any entry for algorithm does. inputEncoding controls how value is read before hashing (utf8 default, or hex/base64 for raw binary data) so binary blobs need no decode round-trip. The canonical use is matching a download against a vendor-published checksum or a lockfile integrity entry.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    operation: z
      .enum(['generate', 'compare'])
      .optional()
      .describe(
        '"generate" produces a digest; "compare" constant-time-checks value against expected. When omitted, resolves to "compare" if expected is supplied and "generate" otherwise.',
      ),
    value: z
      .string()
      .describe('The data to hash, interpreted per inputEncoding (raw text by default).'),
    algorithm: z
      .enum(ALGORITHMS)
      .default('sha256')
      .describe(
        'Digest algorithm. sha256 (default), sha384, or sha512 for security; md5/sha1 are checksum/compat only — not for security.',
      ),
    digestEncoding: z
      .enum(['hex', 'base64', 'sri'])
      .default('hex')
      .describe(
        'Form of the generated digest: lowercase hex (default), standard base64, or sri (<algorithm>-<base64>, sha256/sha384/sha512 only). Applies to operation "generate".',
      ),
    expected: z
      .string()
      .optional()
      .describe(
        'The digest to compare against, as hex (any case), standard base64, or SRI (<algorithm>-<base64>); the form is recognized from its shape at the algorithm\'s digest length, and a string of only hex digits is always read as hex. An SRI value may carry several space-separated entries: entries for other algorithms are skipped, and it matches when any entry for algorithm matches. Supplying it with operation omitted runs a compare; it is rejected with operation "generate".',
      ),
    inputEncoding: z
      .enum(['utf8', 'hex', 'base64'])
      .default('utf8')
      .describe('How value is decoded before hashing: utf8 text, hex, or base64.'),
  }),
  /**
   * The payload key is `value` here and `data` on toolkit_generate_qr; these
   * three name the thing being hashed, never the `expected` digest it is
   * compared against.
   */
  inputAliases: { input: 'value', text: 'value', data: 'value' },
  // Flat object; generate populates digest+lengthInBytes, compare populates matches.
  output: z.object({
    algorithm: z.enum(ALGORITHMS).describe('The algorithm used.'),
    operation: z
      .enum(['generate', 'compare'])
      .describe('The operation performed, after resolving an omitted operation.'),
    digest: z
      .string()
      .optional()
      .describe(
        'Digest of value in the requested digestEncoding: lowercase hex, base64, or <algorithm>-<base64>. Present for operation "generate".',
      ),
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
        'Digest size in bytes (32 for sha256, 48 for sha384, 64 for sha512, 20 for sha1, 16 for md5). Present for "generate".',
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
      reason: 'expected_without_compare',
      code: JsonRpcErrorCode.ValidationError,
      when: 'operation is "generate" but an expected digest was also supplied, so it would be ignored.',
      recovery:
        'Set operation to "compare" (or omit it) to check value against expected, or drop expected to generate a digest.',
    },
    {
      reason: 'expected_malformed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'expected is not a hex, standard base64, or sha256/sha384/sha512 SRI digest, or an SRI value holds a token that is not an SRI entry.',
      recovery:
        'Pass expected as a hex digest, a standard base64 digest, or SRI entries such as sha512-<base64>, space-separated when there are several.',
    },
    {
      reason: 'expected_length_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'expected is a recognized digest form but its length does not match the algorithm, so compare would always fail.',
      recovery:
        "The expected digest length doesn't match the algorithm. Set algorithm to the one that length belongs to, or check the expected value.",
    },
    {
      reason: 'expected_algorithm_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'expected is SRI and none of its entries names the chosen algorithm.',
      recovery:
        'Set algorithm to one named in the SRI prefix of expected, or pass a digest made with the chosen algorithm.',
    },
    {
      reason: 'sri_unsupported_algorithm',
      code: JsonRpcErrorCode.ValidationError,
      when: 'digestEncoding is "sri" and algorithm is md5 or sha1, which SRI does not define.',
      recovery:
        'Use algorithm sha256, sha384, or sha512 for an SRI digest, or set digestEncoding to base64 or hex.',
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
    // A form client sends an untouched optional field as "", so an empty or
    // whitespace-only expected counts as absent rather than as a digest.
    const expected = input.expected?.trim() || undefined;
    const operation = input.operation ?? (expected === undefined ? 'generate' : 'compare');
    const { algorithm } = input;

    if (operation === 'generate' && expected !== undefined) {
      throw ctx.fail(
        'expected_without_compare',
        'expected was supplied with operation "generate", which does not compare.',
        { ...ctx.recoveryFor('expected_without_compare') },
      );
    }
    if (
      operation === 'generate' &&
      input.digestEncoding === 'sri' &&
      !SRI_ALGORITHMS.has(algorithm)
    ) {
      throw ctx.fail(
        'sri_unsupported_algorithm',
        `digestEncoding "sri" is not defined for ${algorithm}.`,
        { ...ctx.recoveryFor('sri_unsupported_algorithm') },
      );
    }

    let data: Buffer;
    try {
      data = decodeInput(input.value, input.inputEncoding);
    } catch {
      throw ctx.fail('invalid_input_encoding', `value is not valid ${input.inputEncoding}.`, {
        ...ctx.recoveryFor('invalid_input_encoding'),
      });
    }

    const digest = createHash(algorithm).update(data).digest();

    if (operation === 'compare') {
      if (expected === undefined) {
        throw ctx.fail('missing_expected', undefined, { ...ctx.recoveryFor('missing_expected') });
      }
      const parsed = parseExpected(expected, algorithm);
      if (parsed.kind === 'malformed') {
        throw ctx.fail(
          'expected_malformed',
          `expected is not a hex, base64, or SRI digest for ${algorithm}.`,
          { ...ctx.recoveryFor('expected_malformed') },
        );
      }
      if (parsed.kind === 'sriAlgorithm') {
        const named = parsed.named.join(' or ');
        throw ctx.fail(
          'expected_algorithm_mismatch',
          `expected is an SRI digest for ${named}, but algorithm is ${algorithm}.`,
          {
            recovery: {
              hint: `Set algorithm to ${named} to match the SRI prefix of expected, or pass a ${algorithm} digest.`,
            },
          },
        );
      }
      if (parsed.kind === 'lengthMismatch') {
        const { fits } = parsed;
        throw ctx.fail(
          'expected_length_mismatch',
          `expected is ${parsed.found}, but a ${algorithm} digest is ${DIGEST_BYTES[algorithm]} bytes (${DIGEST_BYTES[algorithm] * 2} hex characters).`,
          {
            recovery: {
              hint: fits
                ? `expected has the length of a ${fits} digest. Retry with algorithm ${fits}, or pass a ${algorithm} digest.`
                : `The expected digest length doesn't match ${algorithm}. Check the algorithm or the expected value.`,
            },
          },
        );
      }
      const matches = parsed.digests.some((candidate) => timingSafeEqual(digest, candidate));
      ctx.log.info('Hash compare', { algorithm, matches });
      return { algorithm, operation, matches };
    }

    const base64 = digest.toString('base64');
    const rendered =
      input.digestEncoding === 'hex'
        ? digest.toString('hex')
        : input.digestEncoding === 'sri'
          ? `${algorithm}-${base64}`
          : base64;
    ctx.log.info('Hash generate', { algorithm, digestEncoding: input.digestEncoding });
    return { algorithm, operation, digest: rendered, lengthInBytes: digest.length };
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
