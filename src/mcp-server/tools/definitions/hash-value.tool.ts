/**
 * @fileoverview toolkit_hash_value — generate a cryptographic digest or HMAC,
 * or constant-time-compare a value against an expected digest. Pure compute
 * over node:crypto; always-on (no SSRF or info-disclosure surface).
 * @module mcp-server/tools/definitions/hash-value.tool
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type BinaryEncoding, decodeStrict } from '@/utils/strict-decode.js';

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

/** The bytes `value` holds in `encoding`, or `undefined` when it is not valid in that encoding. */
function decodeBytes(value: string, encoding: 'utf8' | BinaryEncoding): Buffer | undefined {
  return encoding === 'utf8' ? Buffer.from(value, 'utf8') : decodeStrict(value, encoding);
}

/**
 * How an `expected` digest was read. `digests` holds every candidate at the
 * algorithm's length (several when an SRI value carries more than one entry
 * for it); the other kinds name the ways it can fail to be read. `found`
 * describes a mismatched length in the shape's own unit, for the error
 * message; `fits` names the algorithm an unlabeled digest of that length
 * belongs to, when there is one.
 */
type ParsedExpected =
  | { kind: 'digests'; digests: Buffer[] }
  | { kind: 'malformed' }
  | { kind: 'multiline' }
  | { kind: 'lengthMismatch'; found: string; fits?: Algorithm | undefined }
  | { kind: 'algorithmMismatch'; named: Algorithm[] };

/** The supported algorithm whose digest is `size` bytes, if any. */
const algorithmOfSize = (size: number): Algorithm | undefined =>
  ALGORITHMS.find((candidate) => DIGEST_BYTES[candidate] === size);

/** One SRI entry: `<algorithm>-<base64>`, for the algorithms SRI defines, the name in any case. */
const SRI_ENTRY = /^(sha256|sha384|sha512)-(.+)$/i;

/**
 * A tagged checksum line: BSD `md5`, `--tag` output, and `openssl dgst`
 * (`SHA256 (<file>) = <digest>`, `SHA2-256(<file>)= <digest>`), with GNU's
 * leading `\` for an escaped file name. The greedy `.*` runs the file name to
 * the last `)` before the digest, so a name holding `(`, `)`, or ` = ` parses.
 * The digest class excludes `)`, `=` (bar trailing padding), and whitespace,
 * which keeps the match linear: each candidate `) =` is followed by a run
 * that stops at the next delimiter.
 */
const TAGGED_LINE =
  /^\\?(md5|sha1|sha256|sha384|sha512|sha2-(?:256|384|512)) ?\(.*\) ?= ?([A-Za-z0-9+/_-]+={0,2})$/i;

/**
 * An untagged checksum line: `sha256sum`, `shasum`, `md5 -r`, `openssl dgst
 * -r` — a hex digest, spaces or tabs, then a file name (with any `*`, `U`, or
 * `^` mode marker) that is discarded. Hex only, so a run of words is not read
 * as a base64 digest of the wrong length. `parseExpected` also refuses a file
 * name of only hex digits, which is a digest split into groups.
 */
const CHECKSUM_LINE = /^\\?([0-9a-fA-F]+)[ \t]+\S/;

/** A run of hex digits and nothing else. */
const HEX_DIGITS = /^[0-9a-fA-F]+$/;

/** A prefixed digest: `sha256:<digest>` (OCI, release assets) or `sha256=<digest>` (signature headers). */
const PREFIXED = /^(md5|sha1|sha256|sha384|sha512)[:=][ \t]*(\S+)$/i;

/** The algorithm a tag or prefix names, matched in any case; OpenSSL's `SHA2-256` is sha256. */
const algorithmNamed = (name: string): Algorithm =>
  // The patterns admit only the supported names and OpenSSL's SHA2- spellings of them.
  name.toLowerCase().replace('sha2-', 'sha') as Algorithm;

/**
 * Decode one bare digest by its shape: all hex digits is hex; otherwise
 * standard base64, otherwise base64url. Hex comes first, so a hex digest of
 * the wrong algorithm is a length mismatch even when its length is valid
 * base64 for this one (64 hex characters are the base64 length of a sha384
 * digest). A string valid in both base64 alphabets decodes to the same bytes
 * in each. `size` is in bytes (fractional for odd-length hex); `found` states
 * the length in the shape's own unit.
 */
function decodeDigest(token: string): { bytes: Buffer; size: number; found: string } | undefined {
  if (HEX_DIGITS.test(token)) {
    return {
      bytes: Buffer.from(token, 'hex'),
      size: token.length / 2,
      found: `${token.length} hex characters`,
    };
  }
  for (const alphabet of ['base64', 'base64url'] as const) {
    const bytes = decodeStrict(token, alphabet);
    if (bytes) return { bytes, size: bytes.length, found: `${alphabet} of ${bytes.length} bytes` };
  }
  return;
}

/**
 * Read one digest for `algorithm`. `named` is the algorithm a surrounding tag
 * or prefix names: one other than `algorithm` fails before the length is
 * checked, and a labeled digest of the wrong length gets no `fits`, since its
 * label contradicts the algorithm its length belongs to.
 */
function readDigest(token: string, algorithm: Algorithm, named?: Algorithm): ParsedExpected {
  const digest = decodeDigest(token);
  if (!digest) return { kind: 'malformed' };
  if (named !== undefined && named !== algorithm) {
    return { kind: 'algorithmMismatch', named: [named] };
  }
  if (digest.size !== DIGEST_BYTES[algorithm]) {
    return {
      kind: 'lengthMismatch',
      found: digest.found,
      fits: named === undefined ? algorithmOfSize(digest.size) : undefined,
    };
  }
  return { kind: 'digests', digests: [digest.bytes] };
}

/**
 * Read SRI metadata: every whitespace-separated token must be an entry, the
 * entries naming `algorithm` are the candidates, and entries for other
 * algorithms are skipped, as SRI metadata allows.
 */
function readSri(tokens: string[], algorithm: Algorithm): ParsedExpected {
  const entries: { named: Algorithm; body: Buffer }[] = [];
  for (const token of tokens) {
    const match = SRI_ENTRY.exec(token);
    const body = match && decodeStrict(match[2] as string, 'base64');
    if (!match || !body) return { kind: 'malformed' };
    entries.push({ named: algorithmNamed(match[1] as string), body });
  }
  const selected = entries.filter((entry) => entry.named === algorithm);
  if (selected.length === 0) {
    return { kind: 'algorithmMismatch', named: [...new Set(entries.map((entry) => entry.named))] };
  }
  const wrong = selected.find((entry) => entry.body.length !== DIGEST_BYTES[algorithm]);
  if (wrong) {
    return { kind: 'lengthMismatch', found: `an SRI digest of ${wrong.body.length} bytes` };
  }
  return { kind: 'digests', digests: selected.map((entry) => entry.body) };
}

/**
 * Read a trimmed `expected`, first form that fits: SRI (when the first token
 * is an entry); a line break (a whole checksum file, refused); a tagged
 * checksum line; an untagged checksum line whose file name is not only hex
 * digits; a prefixed digest; a bare digest. Every pattern here runs over
 * caller text with no length cap, so each pairs adjacent quantifiers over
 * disjoint classes and stays linear.
 */
function parseExpected(expected: string, algorithm: Algorithm): ParsedExpected {
  const tokens = expected.split(/\s+/);
  if (SRI_ENTRY.test(tokens[0] as string)) return readSri(tokens, algorithm);
  if (/[\r\n]/.test(expected)) return { kind: 'multiline' };
  const tagged = TAGGED_LINE.exec(expected);
  if (tagged) {
    return readDigest(tagged[2] as string, algorithm, algorithmNamed(tagged[1] as string));
  }
  const line = CHECKSUM_LINE.exec(expected);
  // Hex in whitespace-separated groups also fits the line; reading its first
  // group as the digest would answer for a fragment of the value.
  if (line && !tokens.slice(1).every((token) => HEX_DIGITS.test(token))) {
    return readDigest(line[1] as string, algorithm);
  }
  const prefixed = PREFIXED.exec(expected);
  if (prefixed) {
    return readDigest(prefixed[2] as string, algorithm, algorithmNamed(prefixed[1] as string));
  }
  return tokens.length > 1 ? { kind: 'malformed' } : readDigest(expected, algorithm);
}

export const hashValueTool = tool('toolkit_hash_value', {
  title: 'toolkit-mcp-server: hash value',
  description:
    'Generate a cryptographic digest or HMAC of a value, or verify a value against an expected digest. Set operation to "generate" for a digest, or "compare" to constant-time-check value against the expected digest — compare is timing-safe and avoids manual string equality checks. Omitting operation compares when expected is supplied and generates otherwise. Algorithm defaults to sha256; sha384 and sha512 are also secure, while md5 and sha1 are exposed ONLY for checksum and file-integrity compatibility and for verifying existing HMAC-SHA1 signatures, and must not be used for passwords, new signatures, or any other security purpose. Set secret to compute HMAC(algorithm, secret, value) instead of a plain digest, for generate and compare alike — the check behind webhook signatures such as GitHub\'s X-Hub-Signature-256 (pass the header value as expected) and HS256 JWT signatures; secretEncoding says how secret is written (utf8 default, hex, base64, or base64url for a JWK k), the result carries hmac: true, and the secret is never echoed back. digestEncoding selects the generated digest form: lowercase hex (default), base64, base64url (unpadded, the JWS signature form), or sri (<algorithm>-<base64>, the npm lockfile integrity and Subresource Integrity form, sha256/sha384/sha512 only, plain digests only). expected is recognized by its shape at the algorithm\'s digest length, so a published checksum can be pasted as-is: a bare hex, base64, or base64url digest; SRI, which may hold several space-separated entries as an npm integrity field can and matches when any entry for algorithm does; one checksum-file line as sha256sum, shasum, md5, or openssl dgst prints it (<hex>  <file>, or SHA256 (<file>) = <digest>); or a digest prefixed sha256: or sha256= (OCI and release-asset digests, webhook signature headers). A tag or prefix naming another algorithm fails rather than being ignored, and a multi-line checksum file must be cut to the one line for the file. inputEncoding controls how value is read before hashing (utf8 default, or hex/base64 for raw binary data) so binary blobs need no decode round-trip. The canonical use is matching a download against a vendor-published checksum or a lockfile integrity entry.',
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
        'Digest algorithm. sha256 (default), sha384, or sha512 for security; md5/sha1 are for checksums and for verifying existing HMAC-SHA1 signatures only — not for new security use.',
      ),
    digestEncoding: z
      .enum(['hex', 'base64', 'base64url', 'sri'])
      .default('hex')
      .describe(
        'Form of the generated digest: lowercase hex (default), standard base64, base64url (URL-safe alphabet, unpadded — the JWS signature form), or sri (<algorithm>-<base64>, sha256/sha384/sha512 only, and not with secret). Applies to operation "generate".',
      ),
    secret: z
      .string()
      .optional()
      .describe(
        'HMAC key. When non-empty, the digest is HMAC(algorithm, secret, value) instead of a plain hash, for generate and compare alike. Read per secretEncoding and used exactly as sent, never trimmed; an empty string counts as absent. Never echoed in the result or in error messages.',
      ),
    secretEncoding: z
      .enum(['utf8', 'hex', 'base64', 'base64url'])
      .default('utf8')
      .describe(
        'How secret is written: utf8 text (default, as a webhook signing secret is), hex, base64, or base64url (as a JWK k member is). Read only when secret is non-empty.',
      ),
    expected: z
      .string()
      .optional()
      .describe(
        'The digest to compare against, recognized from its shape at the algorithm\'s digest length: hex (any case), standard base64, or base64url, bare or prefixed as <algorithm>:<digest> or <algorithm>=<digest>; SRI (<algorithm>-<base64>); or one checksum-file line, <hex>  <file> (sha256sum, shasum, md5 -r) or SHA256 (<file>) = <digest> (BSD, --tag, openssl dgst). A string of only hex digits is always read as hex; hex split by whitespace is rejected, as is a <hex>  <file> line whose file name is only hex digits. An SRI value may carry several space-separated entries: entries for other algorithms are skipped, and it matches when any entry for algorithm matches. A tag or prefix naming another algorithm is rejected, as is a whole multi-line checksum file. Supplying it with operation omitted runs a compare; it is rejected with operation "generate".',
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
    hmac: z
      .literal(true)
      .optional()
      .describe(
        'Present (true) when the digest is an HMAC keyed by secret; absent for a plain digest.',
      ),
    digest: z
      .string()
      .optional()
      .describe(
        'Digest of value in the requested digestEncoding: lowercase hex, base64, unpadded base64url, or <algorithm>-<base64>; the HMAC when hmac is true. Present for operation "generate".',
      ),
    matches: z
      .boolean()
      .optional()
      .describe(
        'Constant-time equality of the computed digest (the HMAC when hmac is true) against expected. Present for operation "compare".',
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
      when: 'expected is not a digest in any form the tool reads, spans several lines (a whole checksum file), or is an SRI value holding a token that is not an SRI entry.',
      recovery:
        'Pass expected as one digest: hex, base64, or base64url, SRI entries such as sha512-<base64>, one line of a checksum file, or a prefixed digest such as sha256:<hex>.',
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
      when: 'expected names an algorithm other than the chosen one, in a checksum-line tag, an <algorithm>: or <algorithm>= prefix, or SRI entries none of which names the chosen algorithm.',
      recovery:
        'Set algorithm to the one expected names, or pass a digest made with the chosen algorithm.',
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
    {
      reason: 'invalid_secret_encoding',
      code: JsonRpcErrorCode.ValidationError,
      when: 'secret is not valid for the declared secretEncoding (e.g. non-hex characters with secretEncoding "hex").',
      recovery:
        'Set secretEncoding to how secret is written: utf8 for a plain-text webhook secret, base64url for a JWK k value, or hex or base64 for raw key bytes.',
    },
    {
      reason: 'sri_with_secret',
      code: JsonRpcErrorCode.ValidationError,
      when: 'digestEncoding is "sri" on operation "generate" and a secret was supplied; SRI carries plain digests, not HMACs.',
      recovery:
        'Set digestEncoding to hex, base64, or base64url for an HMAC, or drop secret to generate a plain SRI digest.',
    },
  ],

  handler(input, ctx) {
    // A form client sends an untouched optional field as "", so an empty or
    // whitespace-only expected counts as absent rather than as a digest, and an
    // empty secret as no secret. A non-empty secret is opaque: never trimmed.
    const expected = input.expected?.trim() || undefined;
    const secret = input.secret || undefined;
    const operation = input.operation ?? (expected === undefined ? 'generate' : 'compare');
    const { algorithm } = input;

    if (operation === 'generate' && expected !== undefined) {
      throw ctx.fail(
        'expected_without_compare',
        'expected was supplied with operation "generate", which does not compare.',
      );
    }
    if (operation === 'generate' && input.digestEncoding === 'sri') {
      // Checked first: its hint (another digestEncoding) also clears an md5/sha1 SRI request.
      if (secret !== undefined) {
        throw ctx.fail(
          'sri_with_secret',
          'digestEncoding "sri" carries a plain digest, and secret makes this an HMAC.',
        );
      }
      if (!SRI_ALGORITHMS.has(algorithm)) {
        throw ctx.fail(
          'sri_unsupported_algorithm',
          `digestEncoding "sri" is not defined for ${algorithm}.`,
        );
      }
    }

    const data = decodeBytes(input.value, input.inputEncoding);
    if (!data) {
      throw ctx.fail('invalid_input_encoding', `value is not valid ${input.inputEncoding}.`);
    }
    let key: Buffer | undefined;
    if (secret !== undefined) {
      key = decodeBytes(secret, input.secretEncoding);
      // The message names the encoding only: the secret never reaches an error.
      if (!key) {
        throw ctx.fail('invalid_secret_encoding', `secret is not valid ${input.secretEncoding}.`);
      }
    }

    const digest = (key ? createHmac(algorithm, key) : createHash(algorithm)).update(data).digest();
    const hmac = key !== undefined;

    if (operation === 'compare') {
      if (expected === undefined) {
        throw ctx.fail('missing_expected');
      }
      const parsed = parseExpected(expected, algorithm);
      if (parsed.kind === 'malformed') {
        throw ctx.fail(
          'expected_malformed',
          `expected is not a ${algorithm} digest in any form this tool reads (hex, base64, base64url, SRI, a checksum line, or a prefixed digest).`,
        );
      }
      if (parsed.kind === 'multiline') {
        throw ctx.fail(
          'expected_malformed',
          'expected spans several lines; it is read as one digest or one checksum line.',
          {
            recovery: {
              hint: 'Pass only the line for this file from the checksum file, or just its digest.',
            },
          },
        );
      }
      if (parsed.kind === 'algorithmMismatch') {
        const named = parsed.named.join(' or ');
        throw ctx.fail(
          'expected_algorithm_mismatch',
          `expected names ${named}, but algorithm is ${algorithm}.`,
          {
            recovery: {
              hint: `expected names ${named}. Retry with algorithm ${named}, or pass a ${algorithm} digest.`,
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
      ctx.log.info('Hash compare', { algorithm, hmac, matches });
      return { algorithm, operation, ...(hmac && { hmac }), matches };
    }

    const rendered =
      input.digestEncoding === 'sri'
        ? `${algorithm}-${digest.toString('base64')}`
        : digest.toString(input.digestEncoding);
    ctx.log.info('Hash generate', { algorithm, hmac, digestEncoding: input.digestEncoding });
    return {
      algorithm,
      operation,
      ...(hmac && { hmac }),
      digest: rendered,
      lengthInBytes: digest.length,
    };
  },

  // Renders whichever fields the operation populated. The linter synthesizes
  // all fields at once, so each is rendered when present.
  format: (result) => {
    const head = [`**Algorithm:** ${result.algorithm}`, `**Operation:** ${result.operation}`];
    if (result.hmac) head.push('**HMAC:** yes, keyed with secret');
    const lines = [head.join(' | ')];
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
