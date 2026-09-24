/**
 * @fileoverview Tests for toolkit_generate_id — format validity, batch count,
 * uniqueness, the time-ordering of v7/ULID, the random same-millisecond step,
 * and the suffix-overflow fallback.
 * @module tests/tools/generate-id.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateIdTool } from '@/mcp-server/tools/definitions/generate-id.tool.js';

/**
 * Byte buffers queued here are returned by the next randomBytes() calls in
 * order; an empty queue falls through to the real CSPRNG. This seeds a suffix
 * at a chosen value without touching the batch logic under test.
 */
const entropy = vi.hoisted(() => ({ queue: [] as Buffer[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number) => entropy.queue.shift() ?? actual.randomBytes(size),
  };
});

const run = (args: unknown) =>
  generateIdTool.handler(generateIdTool.input.parse(args), createMockContext());

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/; // Crockford base32, 26 chars

describe('toolkit_generate_id', () => {
  it('mints a valid UUIDv4', async () => {
    const { ids } = await run({ type: 'uuid_v4', count: 1 });
    expect(ids[0]).toMatch(UUID_V4);
  });

  it('mints a valid UUIDv7 (version nibble 7)', async () => {
    const { ids } = await run({ type: 'uuid_v7', count: 1 });
    expect(ids[0]).toMatch(UUID_V7);
  });

  it('mints a valid ULID (26 Crockford chars)', async () => {
    const { ids } = await run({ type: 'ulid', count: 1 });
    expect(ids[0]).toMatch(ULID);
  });

  it('returns exactly count ids, all unique', async () => {
    const result = await run({ type: 'ulid', count: 100 });
    expect(result.count).toBe(100);
    expect(result.ids).toHaveLength(100);
    expect(new Set(result.ids).size).toBe(100);
  });

  it('UUIDv7 ids are time-ordered (sortable)', async () => {
    const a = (await run({ type: 'uuid_v7', count: 1 })).ids[0]!;
    await new Promise((r) => setTimeout(r, 5));
    const b = (await run({ type: 'uuid_v7', count: 1 })).ids[0]!;
    expect(a < b).toBe(true);
  });

  it('defaults to a single uuid_v4', async () => {
    const result = await run({});
    expect(result.type).toBe('uuid_v4');
    expect(result.count).toBe(1);
  });

  it('mints the maximum batch of 1000 ids, all unique', async () => {
    const result = await run({ type: 'uuid_v4', count: 1000 });
    expect(result.count).toBe(1000);
    expect(new Set(result.ids).size).toBe(1000);
  });

  it('uuid_v7 batches are monotonic — lexicographically sorted within a batch', async () => {
    // A 1000-count batch mints almost entirely within one millisecond; the
    // suffix increments so the ids array equals its lexicographically sorted copy.
    const { ids } = await run({ type: 'uuid_v7', count: 1000 });
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(1000);
  });

  it('ulid batches are monotonic — lexicographically sorted within a batch', async () => {
    const { ids } = await run({ type: 'ulid', count: 1000 });
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(1000);
  });

  it.each([0, 1001, -1, 1.5])('rejects out-of-bounds count %d at the schema boundary', (count) => {
    expect(generateIdTool.input.safeParse({ type: 'ulid', count }).success).toBe(false);
  });

  it('rejects an unknown id type', () => {
    expect(generateIdTool.input.safeParse({ type: 'nanoid' }).success).toBe(false);
  });

  it('output conforms to the declared schema', async () => {
    const result = await run({ type: 'ulid', count: 2 });
    expect(result).toEqual(expect.schemaMatching(generateIdTool.output));
  });

  it('is annotated read-only and non-idempotent', () => {
    // Minting draws from the CSPRNG and returns it — nothing in the environment
    // changes, so readOnlyHint is true. Repeat calls return different values, so
    // idempotentHint stays false and clients must not cache or dedupe them.
    expect(generateIdTool.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
      idempotentHint: false,
    });
  });

  it('format lists every minted id', () => {
    const blocks = generateIdTool.format!({
      type: 'ulid',
      ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW'],
      count: 2,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2 × ulid');
    expect(text).toContain('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(text).toContain('01ARZ3NDEKTSV4RRFFQ69G5FAW');
  });
});

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Split an id into its millisecond timestamp and its random suffix. */
const decode = (type: 'uuid_v7' | 'ulid', id: string): { ms: bigint; rand: bigint } => {
  if (type === 'ulid') {
    let value = 0n;
    for (const char of id) value = (value << 5n) | BigInt(CROCKFORD.indexOf(char));
    return { ms: value >> 80n, rand: value & ((1n << 80n) - 1n) };
  }
  const value = BigInt(`0x${id.replaceAll('-', '')}`);
  const randA = (value >> 64n) & 0xfffn;
  const randB = value & ((1n << 62n) - 1n);
  return { ms: value >> 80n, rand: (randA << 62n) | randB };
};

const SUFFIX_BITS = { uuid_v7: 74, ulid: 80 } as const;
const FORMAT = { uuid_v7: UUID_V7, ulid: ULID } as const;
const FIXED_MS = 1_760_000_000_000;

/**
 * Bytes that randomBigInt() masks down to `max - below` for a suffix of
 * `bits`: all ones, with the low byte lowered by `below`.
 */
const suffixBytes = (bits: number, below: number): Buffer => {
  const bytes = Buffer.alloc(Math.ceil(bits / 8), 0xff);
  bytes[bytes.length - 1] = 0xff - below;
  return bytes;
};

describe('toolkit_generate_id same-millisecond batches', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    entropy.queue.length = 0;
  });

  it.each(['uuid_v7', 'ulid'] as const)(
    '%s: a 1000-id batch in one millisecond is strictly increasing with random gaps',
    async (type) => {
      vi.spyOn(Date, 'now').mockReturnValue(FIXED_MS);
      const { ids } = await run({ type, count: 1000 });
      const parts = ids.map((id) => decode(type, id));
      for (const id of ids) expect(id).toMatch(FORMAT[type]);
      expect(parts.every((p) => p.ms === BigInt(FIXED_MS))).toBe(true);
      const deltas = parts.slice(1).map((p, i) => p.rand - (parts[i] as { rand: bigint }).rand);
      // Strictly increasing, and each step is a 32-bit draw plus one.
      expect(deltas.every((d) => d >= 1n && d <= 2n ** 32n)).toBe(true);
      // Not a constant stride: neighbours are not derivable from one another.
      expect(new Set(deltas).size).toBeGreaterThan(1);
      expect(deltas.filter((d) => d === 1n).length).toBeLessThan(10);
      expect(ids).toEqual([...ids].sort());
    },
  );

  it.each(['uuid_v7', 'ulid'] as const)(
    '%s: a suffix at the maximum advances the timestamp instead of wrapping',
    async (type) => {
      vi.spyOn(Date, 'now').mockReturnValue(FIXED_MS);
      entropy.queue.push(suffixBytes(SUFFIX_BITS[type], 0));
      const { ids } = await run({ type, count: 3 });
      const parts = ids.map((id) => decode(type, id));
      expect(parts[0]).toEqual({
        ms: BigInt(FIXED_MS),
        rand: (1n << BigInt(SUFFIX_BITS[type])) - 1n,
      });
      expect(parts[1]?.ms).toBe(BigInt(FIXED_MS) + 1n);
      expect(new Set(ids).size).toBe(3);
      expect(ids).toEqual([...ids].sort());
      for (const id of ids) expect(id).toMatch(FORMAT[type]);
    },
  );

  it.each(['uuid_v7', 'ulid'] as const)(
    '%s: a suffix a few steps below the maximum overflows rather than wrapping low',
    async (type) => {
      // A step of 17 from max − 5 carries past the field width. The carry must
      // advance the timestamp; masking it back into the field would emit a
      // suffix of 11 in the same millisecond and break the ordering.
      vi.spyOn(Date, 'now').mockReturnValue(FIXED_MS);
      entropy.queue.push(suffixBytes(SUFFIX_BITS[type], 5), Buffer.from([0, 0, 0, 16]));
      const { ids } = await run({ type, count: 50 });
      const parts = ids.map((id) => decode(type, id));
      expect(parts[0]?.rand).toBe((1n << BigInt(SUFFIX_BITS[type])) - 6n);
      expect(parts[1]?.ms).toBe(BigInt(FIXED_MS) + 1n);
      expect(parts[1]?.rand).not.toBe(11n);
      expect(ids).toEqual([...ids].sort());
      expect(new Set(ids).size).toBe(50);
      for (let i = 1; i < parts.length; i++) {
        const prev = parts[i - 1] as { ms: bigint; rand: bigint };
        const cur = parts[i] as { ms: bigint; rand: bigint };
        expect(cur.ms > prev.ms || (cur.ms === prev.ms && cur.rand > prev.rand)).toBe(true);
      }
    },
  );

  it.each(['uuid_v7', 'ulid'] as const)(
    '%s: each same-millisecond step is a fresh 32-bit draw plus one',
    async (type) => {
      vi.spyOn(Date, 'now').mockReturnValue(FIXED_MS);
      const zero = Buffer.alloc(Math.ceil(SUFFIX_BITS[type] / 8));
      entropy.queue.push(zero, Buffer.from([0, 0, 0, 9]), Buffer.from([0xff, 0xff, 0xff, 0xff]));
      const { ids } = await run({ type, count: 3 });
      expect(ids.map((id) => decode(type, id).rand)).toEqual([0n, 10n, 10n + 2n ** 32n]);
    },
  );

  it('leaves uuid_v4 batches as independent draws', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_MS);
    const { ids } = await run({ type: 'uuid_v4', count: 200 });
    expect(new Set(ids).size).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it('returns a same-millisecond batch on both surfaces', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_MS);
    const result = await runToolContract(generateIdTool, { type: 'ulid', count: 5 });
    const { ids, count, type } = generateIdTool.output.parse(result.structuredContent);
    expect({ count, type }).toEqual({ count: 5, type: 'ulid' });
    expect(ids).toEqual([...ids].sort());
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    for (const id of ids) expect(text).toContain(id);
  });
});
