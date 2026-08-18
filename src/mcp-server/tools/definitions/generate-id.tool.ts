/**
 * @fileoverview toolkit_generate_id — mint cryptographically-random identifiers
 * (UUIDv4 / UUIDv7 / ULID), single or batch. Backed by the platform CSPRNG via
 * node:crypto; the one reason to call a tool instead of letting a model invent
 * "random" values. Always-on and read-only — it draws entropy and returns it,
 * changing nothing — but never idempotent: each call is fresh by design.
 * @module mcp-server/tools/definitions/generate-id.tool
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { tool, z } from '@cyanheads/mcp-ts-core';

/** Crockford base32 alphabet (excludes I, L, O, U) — the ULID encoding. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Draw `bits` of CSPRNG randomness as a BigInt. */
function randomBigInt(bits: number): bigint {
  const bytes = randomBytes(Math.ceil(bits / 8));
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value & ((1n << BigInt(bits)) - 1n);
}

/**
 * Mint a monotonic batch of `count` time-ordered identifiers. Within a single
 * millisecond the random suffix is incremented (not redrawn), so the batch is
 * strictly increasing and therefore lexicographically sorted by creation — the
 * contract uuid_v7 and ulid advertise. `randBits` sizes the random suffix (74
 * for UUIDv7, 80 for ULID); `encode` lays the timestamp + suffix into a string.
 */
function monotonicBatch(
  count: number,
  randBits: number,
  encode: (ms: bigint, rand: bigint) => string,
): string[] {
  const randMask = (1n << BigInt(randBits)) - 1n;
  const ids: string[] = [];
  let lastMs = -1n;
  let lastRand = 0n;
  for (let i = 0; i < count; i++) {
    let ms = BigInt(Date.now());
    let rand: bigint;
    if (ms > lastMs) {
      rand = randomBigInt(randBits);
    } else {
      // Same (or backward) clock reading: hold the highest ms seen and bump the
      // suffix, so ordering is preserved without waiting on the wall clock.
      ms = lastMs;
      rand = (lastRand + 1n) & randMask;
      if (rand === 0n) {
        // Suffix wrapped within one ms (unreachable for count ≤ 1000) — step the
        // timestamp and redraw rather than emit a colliding/out-of-order id.
        ms = lastMs + 1n;
        rand = randomBigInt(randBits);
      }
    }
    lastMs = ms;
    lastRand = rand;
    ids.push(encode(ms, rand));
  }
  return ids;
}

/** Encode the low `length` Crockford-base32 chars of `value`, most-significant first. */
function toCrockford(value: bigint, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/**
 * Lay out a UUIDv7 (RFC 9562): 48-bit ms timestamp, version 7, 12-bit rand_a,
 * variant 0b10, 62-bit rand_b. `rand` supplies rand_a (its top 12 bits) and
 * rand_b (its low 62 bits).
 */
function encodeUuidV7(ms: bigint, rand: bigint): string {
  const value =
    (ms << 80n) |
    (0x7n << 76n) |
    ((rand >> 62n) << 64n) | // rand_a — top 12 bits of the 74-bit suffix
    (0b10n << 62n) |
    (rand & ((1n << 62n) - 1n)); // rand_b — low 62 bits
  const hex = value.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Encode a ULID: 48-bit ms timestamp (10 chars) + 80-bit suffix (16 chars), Crockford base32. */
function encodeUlid(ms: bigint, rand: bigint): string {
  return toCrockford(ms, 10) + toCrockford(rand, 16);
}

export const generateIdTool = tool('toolkit_generate_id', {
  title: 'toolkit-mcp-server: generate id',
  description:
    'Mint cryptographically-random identifiers using the platform CSPRNG — the correct source for IDs that must be unpredictable, unlike model-generated values. type selects the format: uuid_v4 (random, the default), uuid_v7 (time-ordered, sortable by creation), or ulid (26-char Crockford-base32, lexicographically sortable). Set count to mint a batch in one call (up to 1000); the returned ids array always contains exactly count values and is never truncated. For uuid_v7 and ulid, a batch is monotonic — strictly increasing even within the same millisecond — so the ids array stays in sorted creation order. IDs from this tool feed into toolkit_generate_qr (pass ids[0] as data) to create a scannable code.',
  // Two independent questions, answered separately. readOnlyHint: does the tool
  // modify its environment? It does not — it draws from the CSPRNG and returns
  // the bytes — so claiming a write would bucket it with genuinely mutating
  // tools and drag every caller through a write-approval flow. idempotentHint:
  // do repeat calls with the same arguments have no additional effect? Each one
  // yields fresh, non-reproducible entropy, so false is what keeps a client
  // from caching or deduplicating a batch.
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: false },
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
      .describe(
        'The minted identifiers — exactly count of them, in mint order; for uuid_v7 and ulid that order is strictly increasing (sorted by creation).',
      ),
    count: z.number().describe('The number of identifiers minted (equals the requested count).'),
  }),

  handler(input, ctx) {
    // uuid_v4 has no ordering contract → independent draws. uuid_v7/ulid run
    // through a monotonic batch so the returned array sorts by creation.
    const ids =
      input.type === 'uuid_v4'
        ? Array.from({ length: input.count }, () => randomUUID())
        : monotonicBatch(
            input.count,
            input.type === 'uuid_v7' ? 74 : 80,
            input.type === 'uuid_v7' ? encodeUuidV7 : encodeUlid,
          );
    ctx.log.info('Generated ids', { type: input.type, count: input.count });
    return { type: input.type, ids, count: ids.length };
  },

  format: (result) => {
    const lines = [`**${result.count} × ${result.type}**`];
    for (const id of result.ids) lines.push(`- \`${id}\``);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
