/**
 * @fileoverview toolkit_generate_qr — encode text or a URL into a QR code as SVG
 * markup, base64-encoded PNG bytes, or a terminal-renderable string. Pure compute
 * via the qrcode library; always-on. The artifact a model cannot type out itself.
 * @module mcp-server/tools/definitions/generate-qr.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import QRCode from 'qrcode';

/**
 * Ceiling on the rendered PNG's edge in pixels. Three caller-supplied inputs
 * multiply into one raster — `data` (via the symbol version), `margin`, and
 * `scale` — so bounding any one of them alone leaves the product unbounded: a
 * ~3 KB request would otherwise render a ~6000 px square and hold the RGBA
 * buffer behind it for the length of the call. At this edge the worst case is
 * ~16 MB, and every realistic scale still fits.
 */
export const QR_MAX_PNG_EDGE_PX = 2048;

/** Modules per side for a QR symbol version (RFC-fixed: 21 at v1, +4 per version). */
const modulesForVersion = (version: number): number => version * 4 + 17;

export const generateQrTool = tool('toolkit_generate_qr', {
  title: 'toolkit-mcp-server: generate QR code',
  description: `Encode text or a URL into a QR code. data is the content to encode (a link, a generated identifier such as toolkit_generate_id's ids[0], or any string). format selects the output: svg returns inline SVG markup, png_base64 returns base64-encoded PNG bytes (with mimeType and byteLength), and terminal returns a block of Unicode block characters renderable in a monospace terminal. errorCorrection (L/M/Q/H) trades data capacity for damage tolerance, margin sets the quiet-zone width, and scale sets pixels per module for raster output. The returned version (1–40) reflects how dense the encoded data is. png_base64 renders (modules + 2 × margin) × scale pixels per side and rejects anything past ${QR_MAX_PNG_EDGE_PX} px with a typed raster_too_large error, so a dense symbol needs a lower scale; svg carries no such limit.`,
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  input: z.object({
    data: z
      .string()
      .min(1)
      .max(2953)
      .describe(
        'The text or URL to encode. 2953 is the absolute ceiling (QR version 40, level L, byte mode); usable capacity drops at higher errorCorrection levels, so over-capacity data is rejected with a typed data_too_large error rather than a generic failure.',
      ),
    format: z
      .enum(['svg', 'png_base64', 'terminal'])
      .default('svg')
      .describe(
        'Output format: svg markup, png_base64 (raster bytes), or a terminal-renderable string.',
      ),
    errorCorrection: z
      .enum(['L', 'M', 'Q', 'H'])
      .default('M')
      .describe(
        'Error-correction level: L (~7% recoverable) to H (~30%). Higher tolerance lowers data capacity.',
      ),
    margin: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(4)
      .describe('Quiet-zone width in modules around the symbol. The spec recommends 4.'),
    scale: z
      .number()
      .int()
      .min(1)
      .max(32)
      .default(4)
      .describe(
        `Pixels per module for raster (png_base64) output. Ignored for terminal. png_base64 also bounds the whole image at ${QR_MAX_PNG_EDGE_PX} px per side, so a dense symbol or a wide margin admits a lower scale than 32.`,
      ),
  }),
  // Flat object; mimeType is set for svg/png, byteLength only for png_base64.
  output: z.object({
    format: z.enum(['svg', 'png_base64', 'terminal']).describe('The format that was produced.'),
    content: z
      .string()
      .describe(
        'The QR artifact: SVG markup, a terminal-renderable string, or base64 PNG bytes for png_base64.',
      ),
    mimeType: z
      .enum(['image/svg+xml', 'image/png'])
      .optional()
      .describe('MIME type of content for image formats. Absent for the terminal format.'),
    byteLength: z
      .number()
      .optional()
      .describe('Decoded byte size of the PNG. Present only for png_base64.'),
    version: z
      .number()
      .describe(
        'QR symbol version (1–40); higher versions hold denser data and indicate denser content.',
      ),
  }),

  errors: [
    {
      reason: 'data_too_large',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'data exceeds the QR capacity for the chosen errorCorrection level and encoding mode.',
      recovery: 'Shorten data, or lower errorCorrection (H→Q→M→L) to raise capacity, then retry.',
    },
    {
      reason: 'raster_too_large',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'format is png_base64 and (modules + 2 × margin) × scale exceeds the pixel budget.',
      recovery: `Lower scale (and margin if needed) so the rendered image stays within ${QR_MAX_PNG_EDGE_PX} px per side, or request format svg, which has no raster budget.`,
    },
  ],

  async handler(input, ctx) {
    const errorCorrectionLevel = input.errorCorrection;
    // create() picks the symbol version and is the single chokepoint that
    // rejects over-capacity data: the schema's 2953 cap is the level-L/byte-mode
    // ceiling, so a payload valid for the schema can still exceed capacity at
    // M/Q/H. Translate that library error into the typed contract reason.
    let version: number;
    try {
      version = QRCode.create(input.data, { errorCorrectionLevel }).version;
    } catch (err) {
      if (err instanceof Error && /too big/i.test(err.message)) {
        throw ctx.fail(
          'data_too_large',
          `data is ${input.data.length} characters, which exceeds the QR capacity at error-correction level ${input.errorCorrection}.`,
          { ...ctx.recoveryFor('data_too_large') },
        );
      }
      throw err;
    }
    ctx.log.info('Generated QR', { format: input.format, version });

    if (input.format === 'svg') {
      const content = await QRCode.toString(input.data, {
        type: 'svg',
        errorCorrectionLevel,
        margin: input.margin,
        scale: input.scale,
      });
      return { format: 'svg' as const, content, mimeType: 'image/svg+xml' as const, version };
    }

    if (input.format === 'terminal') {
      const content = await QRCode.toString(input.data, {
        type: 'terminal',
        errorCorrectionLevel,
        margin: input.margin,
        small: true,
      });
      return { format: 'terminal' as const, content, version };
    }

    // png_base64 is the only format that rasterizes, so it is the only one that
    // needs a budget: svg is vector markup and terminal is a character grid.
    // The check runs before toBuffer(), so an over-budget request costs nothing.
    const modules = modulesForVersion(version);
    const edgePx = (modules + 2 * input.margin) * input.scale;
    if (edgePx > QR_MAX_PNG_EDGE_PX) {
      const maxScale = Math.floor(QR_MAX_PNG_EDGE_PX / (modules + 2 * input.margin));
      throw ctx.fail(
        'raster_too_large',
        `this request renders a ${edgePx}×${edgePx} px image, over the ${QR_MAX_PNG_EDGE_PX} px budget.`,
        {
          recovery: {
            hint: `Retry with scale ${maxScale} or lower (margin ${input.margin}, version ${version} → ${modules} modules), or request format svg, which has no ${QR_MAX_PNG_EDGE_PX} px raster budget.`,
          },
        },
      );
    }

    const png = await QRCode.toBuffer(input.data, {
      type: 'png',
      errorCorrectionLevel,
      margin: input.margin,
      scale: input.scale,
    });
    const content = png.toString('base64');
    // The bytes ride content[] as a standard MCP image block so clients reading
    // that surface can render the code; structuredContent.content keeps the
    // same base64 for callers bound to the declared output contract.
    ctx.content.image(content, 'image/png');
    return {
      format: 'png_base64' as const,
      content,
      mimeType: 'image/png' as const,
      byteLength: png.length,
      version,
    };
  },

  // One combined block so every field (content, mimeType, byteLength, version)
  // is always rendered — the linter synthesizes all fields at once.
  format: (result) => {
    const meta = [
      `format ${result.format}`,
      `version ${result.version}`,
      result.mimeType ? `mimeType ${result.mimeType}` : undefined,
      result.byteLength != null ? `${result.byteLength} bytes` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    // svg/terminal embed the renderable artifact; png is summarized, since its
    // bytes already reach content[] as an image block and structuredContent.content
    // as base64 — a third copy in the markdown twin buys nothing.
    const body =
      result.format === 'png_base64'
        ? 'The PNG is attached as an image block.'
        : result.format === 'svg'
          ? `\n\n\`\`\`svg\n${result.content}\n\`\`\``
          : `\n\n${result.content}`;
    return [{ type: 'text', text: `QR code (${meta}).${body}` }];
  },
});
