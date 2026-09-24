/**
 * @fileoverview toolkit_encode_value — encode or decode a value across
 * base64 / base64url / hex / URL. Pure compute over Buffer + URI functions;
 * always-on.
 * @module mcp-server/tools/definitions/encode-value.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { markdown } from '@cyanheads/mcp-ts-core/utils';

type Encoding = 'base64' | 'base64url' | 'hex' | 'url';
type OutputEncoding = 'utf8' | 'hex' | 'base64';

/**
 * Fatal, so bytes that are not UTF-8 throw instead of becoming U+FFFD, and
 * BOM-preserving, so a leading EF BB BF survives as U+FEFF rather than being
 * silently dropped.
 */
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Raised when the source bytes decode cleanly but are not valid UTF-8 text. */
class NotUtf8Error extends Error {}

/** Encode UTF-8 text into the target encoding. */
function encode(value: string, encoding: Encoding): string {
  if (encoding === 'url') return encodeURIComponent(value);
  return Buffer.from(value, 'utf8').toString(encoding);
}

/**
 * Percent-decode to raw bytes: each `%XX` escape is one byte, every other
 * character contributes its UTF-8 bytes. Throws on a `%` not followed by two
 * hex digits, and on an unpaired surrogate, which has no UTF-8 bytes and would
 * otherwise be written as U+FFFD.
 */
function percentDecodeBytes(value: string): Buffer {
  if (!value.isWellFormed()) throw new RangeError('not valid url');
  const parts: Buffer[] = [];
  let literalStart = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '%') continue;
    const hexPair = value.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hexPair)) throw new RangeError('not valid url');
    parts.push(Buffer.from(value.slice(literalStart, i), 'utf8'), Buffer.from(hexPair, 'hex'));
    i += 2;
    literalStart = i + 1;
  }
  parts.push(Buffer.from(value.slice(literalStart), 'utf8'));
  return Buffer.concat(parts);
}

/**
 * Recover the raw bytes of a hex / base64 / base64url value. Whitespace is
 * stripped first, so line-wrapped (MIME, PEM) and spaced input decodes; throws
 * on anything still malformed.
 */
function decodeBytes(value: string, encoding: Exclude<Encoding, 'url'>): Buffer {
  const compact = value.replace(/\s+/g, '');
  if (encoding === 'hex') {
    if (!/^[0-9a-fA-F]*$/.test(compact) || compact.length % 2 !== 0) {
      throw new RangeError('not valid hex');
    }
    return Buffer.from(compact, 'hex');
  }
  // base64 / base64url — validate the alphabet, then round-trip to confirm.
  const alphabet = encoding === 'base64url' ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/;
  if (!alphabet.test(compact)) throw new RangeError(`not valid ${encoding}`);
  const buf = Buffer.from(compact, encoding);
  const reencoded = buf.toString(encoding).replace(/=+$/, '');
  if (reencoded !== compact.replace(/=+$/, '')) throw new RangeError(`not valid ${encoding}`);
  return buf;
}

/**
 * Decode a value from the source encoding and render the recovered bytes per
 * `outputEncoding`. Throws `RangeError` when the value is malformed for the
 * source encoding, and `NotUtf8Error` when the bytes are well-formed but
 * `outputEncoding` is utf8 and they are not valid UTF-8.
 */
function decode(value: string, encoding: Encoding, outputEncoding: OutputEncoding): string {
  if (encoding === 'url' && outputEncoding === 'utf8') {
    // decodeURIComponent keeps literal characters exactly as sent. With the
    // escape syntax checked first, its only remaining failure is an escape
    // sequence that is not UTF-8.
    if (/%(?![0-9a-fA-F]{2})/.test(value)) throw new RangeError('not valid url');
    try {
      return decodeURIComponent(value);
    } catch {
      throw new NotUtf8Error();
    }
  }
  const bytes = encoding === 'url' ? percentDecodeBytes(value) : decodeBytes(value, encoding);
  if (outputEncoding !== 'utf8') return bytes.toString(outputEncoding);
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new NotUtf8Error();
  }
}

export const encodeValueTool = tool('toolkit_encode_value', {
  title: 'toolkit-mcp-server: encode value',
  description:
    'Encode or decode a value across base64, base64url, hex, or URL (percent) encoding, in either direction. Set operation to "encode" to transform raw UTF-8 text into the chosen encoding, or "decode" to recover the original bytes from an encoded value. Decoded bytes come back as UTF-8 text by default; set outputEncoding to "hex" or "base64" to receive them re-encoded instead, which is lossless for binary data and transcodes between encodings (a base64 digest to hex, for example). Decoding never substitutes replacement characters: bytes that are not valid UTF-8 text are reported as a recoverable error that points at outputEncoding. Whitespace in hex, base64, and base64url values is ignored, so line-wrapped MIME bodies and PEM bodies decode as-is (drop PEM\'s -----BEGIN/END----- lines, which are not base64). base64url uses the URL-safe alphabet (- and _ instead of + and /); url applies encodeURIComponent and percent-decoding. A value that is malformed for the chosen encoding is reported as a recoverable error, not a silent best-effort.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    operation: z
      .enum(['encode', 'decode'])
      .describe(
        '"encode" transforms text into the encoding; "decode" recovers the bytes from an encoded value.',
      ),
    encoding: z
      .enum(['base64', 'base64url', 'hex', 'url'])
      .describe('The encoding to apply: base64, URL-safe base64url, hex, or URL percent-encoding.'),
    value: z
      .string()
      .describe(
        'The value to transform — raw text for encode, an encoded string for decode. Whitespace is ignored when decoding hex, base64, or base64url; a url value is taken literally.',
      ),
    outputEncoding: z
      .enum(['utf8', 'hex', 'base64'])
      .optional()
      .describe(
        'Decode only: how the recovered bytes are returned. utf8 (used when omitted) returns text and fails when the bytes are not valid UTF-8; hex and base64 return the raw bytes re-encoded, losslessly. Rejected when operation is "encode".',
      ),
  }),
  /**
   * The payload key is `value` here and `data` on toolkit_generate_qr, so a
   * caller arriving from either side — or reaching for the generic word —
   * lands on the one declared key rather than an unknown-key rejection.
   */
  inputAliases: { input: 'value', text: 'value', data: 'value' },
  output: z.object({
    encoding: z
      .enum(['base64', 'base64url', 'hex', 'url'])
      .describe('The encoding that was applied.'),
    operation: z.enum(['encode', 'decode']).describe('The operation that was performed.'),
    outputEncoding: z
      .enum(['utf8', 'hex', 'base64'])
      .optional()
      .describe(
        'How result renders the decoded bytes: utf8 text, hex, or base64. Present for operation "decode".',
      ),
    result: z
      .string()
      .describe(
        'The transformed value: encoded text for encode; for decode, the recovered bytes as UTF-8 text, hex, or base64 per outputEncoding.',
      ),
  }),

  errors: [
    {
      reason: 'decode_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'operation is "decode" but value is malformed for the chosen encoding.',
      recovery:
        "Value isn't valid for the chosen encoding. Verify the encoding matches the input, or switch operation to 'encode'.",
    },
    {
      reason: 'decode_not_utf8',
      code: JsonRpcErrorCode.ValidationError,
      when: 'operation is "decode", outputEncoding is utf8 (or omitted), and the decoded bytes are not valid UTF-8 text.',
      recovery:
        "The decoded bytes are binary, not UTF-8 text. Retry with outputEncoding 'hex' or 'base64' to receive the raw bytes losslessly.",
    },
    {
      reason: 'output_encoding_not_applicable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'operation is "encode" and outputEncoding was supplied; it selects how decoded bytes are returned.',
      recovery:
        "outputEncoding applies only to decode. Drop outputEncoding to encode text, or set operation to 'decode'.",
    },
  ],

  handler(input, ctx) {
    if (input.operation === 'encode') {
      if (input.outputEncoding !== undefined) {
        throw ctx.fail(
          'output_encoding_not_applicable',
          'outputEncoding is only valid when operation is "decode".',
          { ...ctx.recoveryFor('output_encoding_not_applicable') },
        );
      }
      ctx.log.info('Encode', { encoding: input.encoding });
      return {
        encoding: input.encoding,
        operation: input.operation,
        result: encode(input.value, input.encoding),
      };
    }
    const outputEncoding = input.outputEncoding ?? 'utf8';
    let result: string;
    try {
      result = decode(input.value, input.encoding, outputEncoding);
    } catch (err) {
      if (err instanceof NotUtf8Error) {
        throw ctx.fail(
          'decode_not_utf8',
          `value decodes to ${input.encoding} bytes that are not valid UTF-8 text.`,
          { ...ctx.recoveryFor('decode_not_utf8') },
        );
      }
      throw ctx.fail('decode_failed', `value is not valid ${input.encoding}.`, {
        ...ctx.recoveryFor('decode_failed'),
      });
    }
    ctx.log.info('Decode', { encoding: input.encoding, outputEncoding });
    return { encoding: input.encoding, operation: input.operation, outputEncoding, result };
  },

  format: (result) => {
    const params = [`operation: ${result.operation}`, `encoding: ${result.encoding}`];
    if (result.outputEncoding !== undefined)
      params.push(`outputEncoding: ${result.outputEncoding}`);
    return [
      {
        type: 'text',
        text: `**${result.operation === 'encode' ? 'Encoded' : 'Decoded'}** (${params.join(', ')}):\n${markdown().codeBlock(result.result).build()}`,
      },
    ];
  },
});
