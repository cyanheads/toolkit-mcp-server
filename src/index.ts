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

/** Setup fills the catalog after framework environment loading and before registration. */
const tools: AnyToolDefinition[] = [];

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
  /**
   * Sent on every initialize, so it carries what a client that never loads the
   * skill still needs; the gates and workflows live in the skill itself.
   */
  instructions:
    "Five tools are always available: toolkit_hash_value (digests and HMACs, and constant-time comparison against a published checksum or signature), toolkit_encode_value (base64, base64url, hex, and URL encoding), toolkit_generate_id (UUIDs and ULIDs from the platform CSPRNG), toolkit_generate_qr (QR codes), and toolkit_geolocate_ip. Geolocation is the only one that calls an outside provider, and its per-minute request budgets belong to this server process and are shared by every caller: send several addresses as one batch and reuse results already returned. The tools work on the strings you pass; none reads a file path or fetches a URL, so a path sent as a value is processed as text. Two host diagnostics, toolkit_check_network and toolkit_check_system, register only when the operator starts the server with TOOLKIT_ENABLE_NET_DIAGNOSTICS=true or TOOLKIT_ENABLE_SYSTEM_INFO=true, and they report on the machine this server runs on, not the caller's. The toolkit-guide skill (skill://toolkit-guide/SKILL.md) carries the gates for reading a digest or signature mismatch, webhook and JWT signing inputs, moving digests between encodings, who runs a network, and host diagnostics.",
  /** Root `skills/`, resolved against the package root and served as skill:// resources. */
  skills: 'skills',
  tools,
  setup() {
    const serverConfig = getServerConfig();
    tools.push(hashValueTool, generateIdTool, generateQrTool, encodeValueTool, geolocateIpTool);
    if (serverConfig.enableNetDiagnostics) tools.push(checkNetworkTool);
    if (serverConfig.enableSystemInfo) tools.push(checkSystemTool);
    initGeoService();
    if (serverConfig.enableNetDiagnostics) {
      initNetDiagService();
    }
  },
});
