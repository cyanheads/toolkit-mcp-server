#!/usr/bin/env node
/**
 * @fileoverview toolkit-mcp-server MCP server entry point.
 *
 * Fail-closed assembly: the five always-on utility tools register on every
 * deployment with zero configuration; the two host-probing tools
 * (toolkit_check_network, toolkit_check_system) are pushed onto the catalog
 * ONLY when their enable-flag is set, so a hosted instance exposes no SSRF or
 * info-disclosure surface — the gated tools are absent from tools/list, not
 * present-and-erroring.
 * @module index
 */

import { type AnyToolDefinition, createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { checkNetworkTool } from './mcp-server/tools/definitions/check-network.tool.js';
import { checkSystemTool } from './mcp-server/tools/definitions/check-system.tool.js';
import { encodeValueTool } from './mcp-server/tools/definitions/encode-value.tool.js';
import { generateIdTool } from './mcp-server/tools/definitions/generate-id.tool.js';
import { generateQrTool } from './mcp-server/tools/definitions/generate-qr.tool.js';
import { geolocateIpTool } from './mcp-server/tools/definitions/geolocate-ip.tool.js';
import { hashValueTool } from './mcp-server/tools/definitions/hash-value.tool.js';
import { initGeoService } from './services/geo/geo-service.js';
import { initNetDiagService } from './services/network/net-diag-service.js';

const serverConfig = getServerConfig();

/** Always-on: pure compute + the SSRF-free geolocation lookup. Zero config. */
const tools: AnyToolDefinition[] = [
  hashValueTool,
  generateIdTool,
  generateQrTool,
  encodeValueTool,
  geolocateIpTool,
];

// Gated tools — registered only behind their enable-flag (fail-closed).
if (serverConfig.enableNetDiagnostics) tools.push(checkNetworkTool);
if (serverConfig.enableSystemInfo) tools.push(checkSystemTool);

await createApp({
  name: 'toolkit-mcp-server',
  title: 'toolkit-mcp-server',
  /**
   * The HTTP session posture, declared in source rather than inferred from the
   * environment (#27). Every tool is request/response — no resource, prompt,
   * subscription, or `ctx.requestInput` gate holds per-session state, and the geo
   * cache and rate limiter are process-level — so the session store and the
   * per-session McpServer allocation buy nothing, and the process scales
   * horizontally without them. An explicit MCP_SESSION_MODE still overrides this.
   */
  sessionMode: 'stateless',
  tools,
  setup() {
    initGeoService();
    if (serverConfig.enableNetDiagnostics) {
      initNetDiagService();
    }
  },
});
