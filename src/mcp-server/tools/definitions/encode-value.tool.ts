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

/** Encode UTF-8 text into the target encoding. */
function encode(value: string, encoding: Encoding): string {
  if (encoding === 'url') return encodeURIComponent(value);
  return Buffer.from(value, 'utf8').toString(encoding);
}

/** Decode a value from the source encoding back to UTF-8 text; throws on malformed input. */
function decode(value: string, encoding: Encoding): string {
  if (encoding === 'url') return decodeURIComponent(value);
  if (encoding === 'hex') {
    if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
      throw new RangeError('not valid hex');
    }
    return Buffer.from(value, 'hex').toString('utf8');
  }
  // base64 / base64url — validate the alphabet, then round-trip to confirm.
  const alphabet = encoding === 'base64url' ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/;
  if (!alphabet.test(value)) throw new RangeError(`not valid ${encoding}`);
  const buf = Buffer.from(value, encoding);
  const reencoded = buf.toString(encoding).replace(/=+$/, '');
  if (reencoded !== value.replace(/=+$/, '')) throw new RangeError(`not valid ${encoding}`);
  return buf.toString('utf8');
}

export const encodeValueTool = tool('toolkit_encode_value', {
  title: 'toolkit-mcp-server: encode value',
  description:
    'Encode or decode a value across base64, base64url, hex, or URL (percent) encoding, in either direction. Set operation to "encode" to transform raw UTF-8 text into the chosen encoding, or "decode" to recover the original text from an encoded value. base64url uses the URL-safe alphabet (- and _ instead of + and /); url applies encodeURIComponent / decodeURIComponent. Decoding a value that is malformed for the chosen encoding is reported as a recoverable error, not a silent best-effort.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    operation: z
      .enum(['encode', 'decode'])
      .describe(
        '"encode" transforms text into the encoding; "decode" recovers text from an encoded value.',
      ),
    encoding: z
      .enum(['base64', 'base64url', 'hex', 'url'])
      .describe('The encoding to apply: base64, URL-safe base64url, hex, or URL percent-encoding.'),
    value: z
      .string()
      .describe('The value to transform — raw text for encode, an encoded string for decode.'),
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
    result: z.string().describe('The transformed value (encoded text, or the decoded original).'),
  }),

  errors: [
    {
      reason: 'decode_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'operation is "decode" but value is malformed for the chosen encoding.',
      recovery:
        "Value isn't valid for the chosen encoding. Verify the encoding matches the input, or switch operation to 'encode'.",
    },
  ],

  handler(input, ctx) {
    if (input.operation === 'encode') {
      ctx.log.info('Encode', { encoding: input.encoding });
      return {
        encoding: input.encoding,
        operation: input.operation,
        result: encode(input.value, input.encoding),
      };
    }
    try {
      const result = decode(input.value, input.encoding);
      ctx.log.info('Decode', { encoding: input.encoding });
      return { encoding: input.encoding, operation: input.operation, result };
    } catch {
      throw ctx.fail('decode_failed', `value is not valid ${input.encoding}.`, {
        ...ctx.recoveryFor('decode_failed'),
      });
    }
  },

  format: (result) => [
    {
      type: 'text',
      text: `**${result.operation === 'encode' ? 'Encoded' : 'Decoded'}** (operation: ${result.operation}, encoding: ${result.encoding}):\n${markdown().codeBlock(result.result).build()}`,
    },
  ],
});
