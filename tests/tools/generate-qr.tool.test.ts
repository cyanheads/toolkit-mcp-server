/**
 * @fileoverview Tests for toolkit_generate_qr — the three output formats, PNG
 * byte validity, version reflecting data density, the PNG image content block,
 * the rendered-raster pixel budget, the escape-free terminal grid read back
 * module by module, svg sizing by scale, and byte-counted capacity errors.
 * @module tests/tools/generate-qr.tool.test
 */

import { createHash } from 'node:crypto';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getContentBlocks,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import QRCode from 'qrcode';
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

  it('renders the same PNG bytes for a fixed input', async () => {
    const result = await run({ data: 'abc', format: 'png_base64' });
    expect(createHash('sha256').update(result.content, 'base64').digest('hex')).toBe(
      PNG_ABC_SHA256,
    );
    expect(result).toMatchObject({ version: 1, byteLength: PNG_ABC_BYTES, mimeType: 'image/png' });
  });

  it('sizes the SVG viewBox in modules, quiet zone included', async () => {
    // "abc" is version 1 (21 modules); the default margin adds 4 on each side.
    const result = await run({ data: 'abc', format: 'svg' });
    expect(result.content).toContain('viewBox="0 0 29 29"');
  });
});

/** Pinned PNG for `{ data: 'abc', format: 'png_base64' }` at the defaults. */
const PNG_ABC_SHA256 = 'ddada71d53a7f9a2c72f2d3b4fc78bc0cbc275d463e0150d12aade925dacff37';
const PNG_ABC_BYTES = 749;

/** Every text block of a contract result, joined. */
const textOf = (content: { type: string; text?: string }[]) =>
  content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

/**
 * Read a terminal grid back into module rows: each character is a top and a
 * bottom half, and a drawn half (block ink) is a light module. Returns
 * booleans where `true` is dark, matching `QRCode.create().modules`.
 */
const gridToModules = (grid: string): boolean[][] => {
  const halves: Record<string, [boolean, boolean]> = {
    '█': [false, false],
    '▀': [false, true],
    '▄': [true, false],
    ' ': [true, true],
  };
  const rows: boolean[][] = [];
  for (const line of grid.split('\n')) {
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const char of line) {
      const pair = halves[char];
      if (!pair) throw new Error(`unexpected grid character ${JSON.stringify(char)}`);
      top.push(pair[0]);
      bottom.push(pair[1]);
    }
    rows.push(top, bottom);
  }
  return rows;
};

/** The expected module grid: the symbol inside a light quiet zone of `margin` modules. */
const paddedModules = (
  data: string,
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H',
  margin: number,
) => {
  const { modules } = QRCode.create(data, { errorCorrectionLevel });
  const edge = modules.size + 2 * margin;
  return Array.from({ length: edge }, (_, y) =>
    Array.from({ length: edge }, (_, x) => {
      const row = y - margin;
      const col = x - margin;
      if (row < 0 || col < 0 || row >= modules.size || col >= modules.size) return false;
      return Boolean(modules.data[row * modules.size + col]);
    }),
  );
};

describe('toolkit_generate_qr terminal output', () => {
  it('carries no ANSI escape bytes on either surface', async () => {
    const result = await runToolContract(generateQrTool, {
      data: 'https://example.com',
      format: 'terminal',
    });
    const structured = result.structuredContent as { content: string };
    expect(structured.content).not.toContain('\x1b');
    expect(textOf(result.content)).not.toContain('\x1b');
  });

  it('fences the grid in content[] so a Markdown client keeps its spacing', async () => {
    const result = await runToolContract(generateQrTool, { data: 'abc', format: 'terminal' });
    const grid = (result.structuredContent as { content: string }).content;
    const text = textOf(result.content);
    expect(text).toContain(`\n\`\`\`\n${grid}\n\`\`\``);
  });

  it('draws a dark module as a space and a light module as a block', async () => {
    // "abc" at margin 4: character row 2 holds symbol rows 0 and 1. The finder
    // pattern's top-left corner is dark over dark (a space); one column right
    // it is dark over light (a lower-half block).
    const result = await run({ data: 'abc', format: 'terminal' });
    const lines = result.content.split('\n');
    expect(lines[0]).toMatch(/^█+$/);
    expect(lines[2]?.[4]).toBe(' ');
    expect(lines[2]?.[5]).toBe('▄');
  });

  it.each([
    ['a version-1 symbol at the default margin', 'abc', 'M', 4],
    ['a version-10 symbol with an odd margin', 'x'.repeat(200), 'Q', 3],
    ['a symbol with no quiet zone', 'hello', 'H', 0],
    ['a symbol with a one-module quiet zone', 'hello', 'L', 1],
  ] as const)(
    'maps every character back to the module grid for %s',
    async (_label, data, ec, margin) => {
      const result = await run({ data, format: 'terminal', errorCorrection: ec, margin });
      const expected = paddedModules(data, ec, margin);
      const decoded = gridToModules(result.content);
      expect(decoded[0]).toHaveLength(expected.length);
      // An odd row count leaves a trailing half-row with no module; it renders as
      // no ink, which reads back as dark.
      expect(decoded.length).toBe(expected.length + (expected.length % 2));
      expect(decoded.slice(0, expected.length)).toEqual(expected);
      if (expected.length % 2) expect(decoded.at(-1)?.every(Boolean)).toBe(true);
    },
  );

  it('honors margin as the quiet-zone width', async () => {
    const narrow = await run({ data: 'abc', format: 'terminal', margin: 1 });
    const wide = await run({ data: 'abc', format: 'terminal', margin: 6 });
    expect(narrow.content.split('\n')[0]).toHaveLength(21 + 2);
    expect(wide.content.split('\n')[0]).toHaveLength(21 + 12);
  });
});

describe('toolkit_generate_qr svg scale', () => {
  const widthOf = (svg: string) => /<svg[^>]*\swidth="(\d+)"/.exec(svg)?.[1];
  const heightOf = (svg: string) => /<svg[^>]*\sheight="(\d+)"/.exec(svg)?.[1];

  it('produces different markup for scale 1 and scale 20', async () => {
    const small = await run({ data: 'https://example.com', format: 'svg', scale: 1 });
    const large = await run({ data: 'https://example.com', format: 'svg', scale: 20 });
    expect(small.content).not.toBe(large.content);
  });

  it.each([
    [1, 4],
    [20, 4],
    [7, 0],
    [32, 20],
  ])(
    'sets width and height to (modules + 2 × margin) × scale at scale %d, margin %d',
    async (scale, margin) => {
      const result = await run({ data: 'https://example.com', format: 'svg', scale, margin });
      const edge = (result.version * 4 + 17 + 2 * margin) * scale;
      expect(widthOf(result.content)).toBe(String(edge));
      expect(heightOf(result.content)).toBe(String(edge));
      expect(result.content).toContain(`viewBox="0 0 ${result.version * 4 + 17 + 2 * margin} `);
    },
  );

  it('keeps svg outside the raster budget at the largest symbol and scale', async () => {
    const result = await run({
      data: 'x'.repeat(2953),
      format: 'svg',
      errorCorrection: 'L',
      margin: 20,
      scale: 32,
    });
    expect(widthOf(result.content)).toBe(String((177 + 40) * 32));
  });
});

describe('toolkit_generate_qr summary text and byte counts', () => {
  it('separates the png metadata from the next sentence', async () => {
    const result = await runToolContract(generateQrTool, { data: 'abc', format: 'png_base64' });
    expect(textOf(result.content)).toMatch(/bytes\)\. The PNG is attached/);
  });

  it('reports a multi-byte payload over capacity in UTF-8 bytes', async () => {
    // 1000 check marks are 1000 UTF-16 code units — inside the schema cap — but
    // 3000 UTF-8 bytes, past even level L's byte-mode capacity.
    const error = await run({ data: '✓'.repeat(1000), errorCorrection: 'M' }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ data: { reason: 'data_too_large' } });
    expect((error as Error).message).toContain('3000 bytes');
    expect((error as Error).message).not.toContain('1000');
  });

  it('puts the byte count and recovery hint on the wire for data_too_large', async () => {
    const result = await runToolContract(generateQrTool, {
      data: '✓'.repeat(1000),
      errorCorrection: 'M',
    });
    const { error } = z
      .object({
        error: z.object({
          code: z.number(),
          message: z.string(),
          data: z.object({ reason: z.string(), recovery: z.object({ hint: z.string() }) }),
        }),
      })
      .parse(result.structuredContent);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('data_too_large');
    expect(error.message).toContain('3000 bytes');
    expect(textOf(result.content)).toContain(error.data.recovery.hint);
  });
});
