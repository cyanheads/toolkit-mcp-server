/**
 * @fileoverview Tests for toolkit_generate_qr — the three output formats, PNG
 * byte validity, version reflecting data density, the PNG image content block,
 * and the rendered-raster pixel budget.
 * @module tests/tools/generate-qr.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getContentBlocks } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  generateQrTool,
  QR_MAX_PNG_EDGE_PX,
} from '@/mcp-server/tools/definitions/generate-qr.tool.js';

/** Run the handler on a caller-visible context so content blocks can be read. */
const runWith = async (args: unknown) => {
  const ctx = createMockContext({ errors: generateQrTool.errors });
  const result = await generateQrTool.handler(generateQrTool.input.parse(args), ctx);
  return { result, ctx };
};

const run = async (args: unknown) => (await runWith(args)).result;

const PNG_MAGIC = '89504e470d0a1a0a';

/** Rendered edge in pixels for a symbol version at a given margin and scale. */
const edgePx = (version: number, margin: number, scale: number) =>
  (version * 4 + 17 + 2 * margin) * scale;

describe('toolkit_generate_qr', () => {
  it('produces well-formed SVG markup', async () => {
    const result = await run({ data: 'https://caseyjhand.com', format: 'svg' });
    expect(result.format).toBe('svg');
    expect(result.mimeType).toBe('image/svg+xml');
    expect(result.content).toMatch(/^<\?xml|^<svg/);
    expect(result.content).toContain('</svg>');
    expect(result.version).toBeGreaterThanOrEqual(1);
  });

  it('produces base64 PNG bytes with a valid PNG header', async () => {
    const result = await run({ data: 'https://caseyjhand.com', format: 'png_base64' });
    expect(result.format).toBe('png_base64');
    expect(result.mimeType).toBe('image/png');
    const bytes = Buffer.from(result.content, 'base64');
    expect(bytes.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
    expect(result.byteLength).toBe(bytes.length);
  });

  it('produces a non-empty terminal string with no mimeType', async () => {
    const result = await run({ data: 'abc', format: 'terminal' });
    expect(result.format).toBe('terminal');
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.mimeType).toBeUndefined();
    expect(result.byteLength).toBeUndefined();
  });

  it('version grows with data density', async () => {
    const small = await run({ data: 'hi', format: 'svg' });
    const large = await run({ data: 'x'.repeat(800), format: 'svg' });
    expect(large.version).toBeGreaterThan(small.version);
  });

  it('higher error correction needs a denser symbol for the same data', async () => {
    // Level H reserves ~30% for recovery, so it must use an equal-or-larger version
    // than level L for identical data — and strictly larger for a payload at the edge.
    const low = await run({ data: 'x'.repeat(200), format: 'svg', errorCorrection: 'L' });
    const high = await run({ data: 'x'.repeat(200), format: 'svg', errorCorrection: 'H' });
    expect(high.version).toBeGreaterThan(low.version);
  });

  it('defaults to svg format with level M', async () => {
    const result = await run({ data: 'abc' });
    expect(result.format).toBe('svg');
  });

  it('honors a custom margin in the SVG output', async () => {
    // A wider quiet zone enlarges the viewBox vs the default margin.
    const tight = await run({ data: 'abc', format: 'svg', margin: 0 });
    const wide = await run({ data: 'abc', format: 'svg', margin: 10 });
    expect(wide.content).not.toBe(tight.content);
  });

  it.each([
    {}, // missing data
    { data: '' }, // empty data — below min(1)
    { data: 'x'.repeat(2954) }, // one past the 2953-byte QR ceiling
    { data: 'abc', errorCorrection: 'Z' }, // unknown EC level
    { data: 'abc', margin: 21 }, // margin above max(20)
    { data: 'abc', scale: 0 }, // scale below min(1)
    { data: 'abc', scale: 33 }, // scale above max(32)
  ])('rejects invalid input %j at the schema boundary', (args) => {
    expect(generateQrTool.input.safeParse(args).success).toBe(false);
  });

  it('accepts data exactly at the 2953-byte ceiling', () => {
    expect(generateQrTool.input.safeParse({ data: 'x'.repeat(2953) }).success).toBe(true);
  });

  it('encodes a max-length payload at level L (fits version 40)', async () => {
    // 2953 bytes is exactly the byte-mode capacity of version 40 at level L.
    const result = await run({ data: 'x'.repeat(2953), format: 'svg', errorCorrection: 'L' });
    expect(result.version).toBe(40);
  });

  it('rejects over-capacity data with a typed data_too_large error, not an internal failure', async () => {
    // 2953 bytes passes the schema and fits level L, but exceeds the ~2331-byte
    // capacity at level M — caught and surfaced as a declared ValidationError
    // instead of the raw qrcode "too big" internal error.
    const error = await run({ data: 'x'.repeat(2953), errorCorrection: 'M' }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'data_too_large' },
    });
    expect((error as Error).message).not.toMatch(/too big/i);
  });

  it('output conforms to the declared schema', async () => {
    const result = await run({ data: 'abc', format: 'png_base64' });
    expect(result).toEqual(expect.schemaMatching(generateQrTool.output));
  });

  it('emits the PNG as a single image content block matching structuredContent', async () => {
    const { result, ctx } = await runWith({ data: 'qr parity test', format: 'png_base64' });
    expect(getContentBlocks(ctx)).toEqual([
      { type: 'image', data: result.content, mimeType: 'image/png' },
    ]);
  });

  it.each(['svg', 'terminal'] as const)('emits no content block for %s', async (format) => {
    const { ctx } = await runWith({ data: 'abc', format });
    expect(getContentBlocks(ctx)).toEqual([]);
  });

  it('emits the complete image block for the largest permitted raster', async () => {
    // Version 40 at level L with the largest scale the pixel budget allows —
    // the image block carries every byte, untruncated.
    const { result, ctx } = await runWith({
      data: 'x'.repeat(2953),
      format: 'png_base64',
      errorCorrection: 'L',
      scale: 11,
    });
    expect(result.version).toBe(40);
    const block = getContentBlocks(ctx)[0] as { data: string };
    expect(block.data).toBe(result.content);
    expect(Buffer.from(block.data, 'base64')).toHaveLength(result.byteLength as number);
  });

  it('rejects a raster over the pixel budget with a typed error', async () => {
    // Version 40 (177 modules) at scale 32 renders a ~5900 px square — a ~180 MB
    // RGBA buffer from a 3 KB request.
    const error = await run({
      data: 'x'.repeat(2953),
      format: 'png_base64',
      errorCorrection: 'L',
      scale: 32,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'raster_too_large' },
    });
    // The hint names a scale that fits, so the caller's next attempt succeeds.
    const hint = (error as { data: { recovery?: { hint?: string } } }).data.recovery?.hint ?? '';
    expect(hint).toMatch(/scale/i);
    expect(hint).toContain(String(QR_MAX_PNG_EDGE_PX));
  });

  it('rejects a small symbol whose margin and scale still blow the budget', async () => {
    // A tiny payload is not a free pass: margin 20 at scale 32 exceeds the
    // budget from version 2 upward.
    const error = await run({
      data: 'x'.repeat(20),
      format: 'png_base64',
      margin: 20,
      scale: 32,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ data: { reason: 'raster_too_large' } });
  });

  it('accepts the raster on the permitted side of the budget and rejects one step past', async () => {
    const data = 'x'.repeat(2953);
    expect(edgePx(40, 4, 11)).toBeLessThanOrEqual(QR_MAX_PNG_EDGE_PX);
    expect(edgePx(40, 4, 12)).toBeGreaterThan(QR_MAX_PNG_EDGE_PX);
    await expect(
      run({ data, format: 'png_base64', errorCorrection: 'L', scale: 11 }),
    ).resolves.toMatchObject({ format: 'png_base64' });
    await expect(
      run({ data, format: 'png_base64', errorCorrection: 'L', scale: 12 }),
    ).rejects.toMatchObject({ data: { reason: 'raster_too_large' } });
  });

  it('leaves svg and terminal unbounded — only the raster path has a budget', async () => {
    const args = { data: 'x'.repeat(2953), errorCorrection: 'L', margin: 20, scale: 32 } as const;
    await expect(run({ ...args, format: 'svg' })).resolves.toMatchObject({ format: 'svg' });
    await expect(run({ ...args, format: 'terminal' })).resolves.toMatchObject({
      format: 'terminal',
    });
  });

  it('format embeds the SVG artifact and summarizes PNG without dumping base64', () => {
    const svgText = (
      generateQrTool.format!({
        format: 'svg',
        content: '<svg>…</svg>',
        mimeType: 'image/svg+xml',
        version: 2,
      })[0] as { text: string }
    ).text;
    expect(svgText).toContain('<svg>…</svg>'); // svg embeds the renderable artifact
    expect(svgText).toContain('version 2');

    const pngText = (
      generateQrTool.format!({
        format: 'png_base64',
        content: 'QUJD', // base64 — must NOT be echoed into the markdown twin
        mimeType: 'image/png',
        byteLength: 123,
        version: 3,
      })[0] as { text: string }
    ).text;
    expect(pngText).toContain('png_base64');
    expect(pngText).toContain('image/png');
    expect(pngText).toContain('version 3');
    expect(pngText).toContain('123 bytes');
    expect(pngText).not.toContain('QUJD'); // the payload rides the image block, not the text
  });
});
