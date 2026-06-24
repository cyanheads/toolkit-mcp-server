/**
 * @fileoverview toolkit_generate_id — mint cryptographically-random identifiers
 * (UUIDv4 / UUIDv7 / ULID), single or batch. Backed by the platform CSPRNG via
 * node:crypto; the one reason to call a tool instead of letting a model invent
 * "random" values. Always-on, but readOnlyHint:false — each call is fresh,
 * non-idempotent entropy by design.
 * @module mcp-server/tools/definitions/generate-id.tool
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { tool, z } from '@cyanheads/mcp-ts-core';

/** Crockford base32 alphabet (excludes I, L, O, U) — the ULID encoding. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a UUIDv7: 48-bit big-endian Unix-ms timestamp, version/variant bits,
 * 74 bits of CSPRNG randomness. Time-ordered, RFC 9562 layout.
 */
function uuidV7(): string {
  const bytes = randomBytes(16);
  const ms = Date.now();
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Generate a ULID: 48-bit ms timestamp + 80 bits CSPRNG randomness, encoded as
 * 26 Crockford-base32 chars (10 time + 16 random). Lexicographically sortable.
 */
function ulid(): string {
  let time = Date.now();
  const timeChars: string[] = [];
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = CROCKFORD[time % 32]!;
    time = Math.floor(time / 32);
  }
  // 16 random chars = 80 bits. Draw a fresh byte per char and mask to 5 bits.
  const rand = randomBytes(16);
  const randChars = Array.from(rand, (b) => CROCKFORD[b & 0x1f]!);
  return timeChars.join('') + randChars.join('');
}

export const generateIdTool = tool('toolkit_generate_id', {
  title: 'toolkit-mcp-server: generate id',
  description:
    'Mint cryptographically-random identifiers using the platform CSPRNG — the correct source for IDs that must be unpredictable, unlike model-generated values. type selects the format: uuid_v4 (random, the default), uuid_v7 (time-ordered, sortable by creation), or ulid (26-char Crockford-base32, lexicographically sortable). Set count to mint a batch in one call (up to 1000); the returned ids array always contains exactly count values and is never truncated. IDs from this tool feed into toolkit_generate_qr (pass ids[0] as data) to create a scannable code.',
  // Deliberately NOT read-only: each call produces fresh, non-reproducible
  // entropy. readOnlyHint:false / idempotentHint:false prevent a client from
  // treating it as a side-effect-free, auto-approvable, cacheable call.
  annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: false },
  input: z.object({
    type: z
      .enum(['uuid_v4', 'uuid_v7', 'ulid'])
      .default('uuid_v4')
      .describe(
        'Identifier format: uuid_v4 (random), uuid_v7 (time-ordered), or ulid (sortable Crockford-base32).',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(1)
      .describe('How many identifiers to mint (1–1000). The full batch is always returned.'),
  }),
  output: z.object({
    type: z.enum(['uuid_v4', 'uuid_v7', 'ulid']).describe('The identifier format that was minted.'),
    ids: z
      .array(z.string().describe('A single minted identifier.'))
      .describe('The minted identifiers — exactly count of them, in mint order.'),
    count: z.number().describe('The number of identifiers minted (equals the requested count).'),
  }),

  handler(input, ctx) {
    const mint = input.type === 'uuid_v4' ? randomUUID : input.type === 'uuid_v7' ? uuidV7 : ulid;
    const ids = Array.from({ length: input.count }, () => mint());
    ctx.log.info('Generated ids', { type: input.type, count: input.count });
    return { type: input.type, ids, count: ids.length };
  },

  format: (result) => {
    const lines = [`**${result.count} × ${result.type}**`];
    for (const id of result.ids) lines.push(`- \`${id}\``);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
