/**
 * @fileoverview Strict hex / base64 / base64url → bytes, shared by the tools
 * that read caller-supplied binary text. `Buffer.from` decodes all three
 * leniently (skipping bad characters, accepting either alphabet), so each is
 * validated before it is trusted.
 * @module utils/strict-decode
 */

export type BinaryEncoding = 'hex' | 'base64' | 'base64url';

const BASE64_ALPHABETS = {
  base64: /^[A-Za-z0-9+/]*={0,2}$/,
  base64url: /^[A-Za-z0-9_-]*={0,2}$/,
} as const;

/**
 * The bytes `value` holds in `encoding`, or `undefined` when it is not valid
 * there. Hex must be whole bytes; base64 and base64url take optional padding
 * and must round-trip to the same canonical text.
 */
export function decodeStrict(value: string, encoding: BinaryEncoding): Buffer | undefined {
  if (encoding === 'hex') {
    return /^[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0
      ? Buffer.from(value, 'hex')
      : undefined;
  }
  if (!BASE64_ALPHABETS[encoding].test(value)) return;
  const buf = Buffer.from(value, encoding);
  return buf.toString(encoding).replace(/=+$/, '') === value.replace(/=+$/, '') ? buf : undefined;
}
