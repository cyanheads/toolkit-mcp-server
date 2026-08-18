/**
 * @fileoverview Tests for toolkit_generate_id — format validity, batch count,
 * uniqueness, and the time-ordering of v7/ULID.
 * @module tests/tools/generate-id.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { generateIdTool } from '@/mcp-server/tools/definitions/generate-id.tool.js';

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
