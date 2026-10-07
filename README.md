<div align="center">
  <h1>@cyanheads/toolkit-mcp-server</h1>
  <p><b>Generate random IDs, QR codes, and hashes, encode and decode values, and geolocate IPs, plus gated network and system diagnostics, via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-2.3.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/toolkit-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/toolkit-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/toolkit-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/toolkit-mcp-server/releases/latest/download/toolkit-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=toolkit-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdG9vbGtpdC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22toolkit-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ftoolkit-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://toolkit.caseyjhand.com/mcp](https://toolkit.caseyjhand.com/mcp)

</div>

---

## Overview

Developer utilities that run in-process: generate identifiers, QR codes, and cryptographic digests, and encode or decode values. Geolocating a public IP or hostname is the one outbound call, and two host-diagnostic tools stay off unless enabled. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `toolkit_hash_value` | Generate a digest (sha256/sha384/sha512/sha1/md5) as hex, base64, or SRI, or constant-time-compare a value against an expected digest |
| `toolkit_generate_id` | Mint cryptographically random UUIDv4, UUIDv7, or ULID identifiers, up to 1000 per call |
| `toolkit_generate_qr` | Encode text or a URL as a QR code in SVG, base64 PNG, or terminal half-blocks |
| `toolkit_encode_value` | Encode or decode base64, base64url, hex, or URL percent-encoding |
| `toolkit_geolocate_ip` | Resolve a public IP or hostname to country, city, coordinates, ASN, and timezone |
| `toolkit_check_network` | **Gated, off by default.** Ping, traceroute, TCP connectivity, or egress-IP check from the server host |
| `toolkit_check_system` | **Gated, off by default.** OS, CPU, memory, load average, or network interfaces of the server host |

## Capability reference

### `toolkit_hash_value` <sub>tool</sub>

- `value` read per `inputEncoding` (`utf8` default, `hex`, `base64`); `algorithm` is `sha256` (default), `sha384`, or `sha512`, with `sha1` and `md5` for checksum compatibility only; `operation` is `generate` or `compare`, and when omitted it compares if `expected` is sent
- `generate` returns `digest` in `digestEncoding` (`hex` default, `base64`, or `sri` for the SHA-2 algorithms) plus `lengthInBytes`; `compare` returns `matches` against `expected`, given as hex, base64, or SRI, including a multi-entry npm `integrity` value
- A bad `expected` fails as `expected_malformed`, `expected_length_mismatch` (the hint names the algorithm that length fits), or `expected_algorithm_mismatch`

---

### `toolkit_generate_id` <sub>tool</sub>

- `type` is `uuid_v4` (default), `uuid_v7`, or `ulid`; `count` is 1–1000 (default 1)
- `ids` always holds exactly `count` values; `uuid_v7` and `ulid` batches are strictly increasing even within one millisecond, with random gaps so no id is derivable from another

---

### `toolkit_generate_qr` <sub>tool</sub>

- `data` up to 2953 UTF-8 bytes at `errorCorrection` `L`, less at `M` (default), `Q`, and `H`; `format` is `svg` (default), `png_base64`, or `terminal`; `margin` 0–20 modules (default 4), `scale` 1–32 px per module (default 4)
- Returns `content`, the symbol `version` (1–40), `mimeType` for image formats, and `byteLength` for PNG; `png_base64` also arrives as an MCP image block, and `terminal` is plain Unicode half-blocks drawn for a dark background
- Over-capacity input fails as `data_too_large` with its byte count; a PNG over 2048 px per side fails as `raster_too_large` with a scale that fits, while `svg` and `terminal` have no pixel cap

---

### `toolkit_encode_value` <sub>tool</sub>

- `operation` (`encode` or `decode`) and `encoding` (`base64`, `base64url`, `hex`, `url`) are required; whitespace in `hex`, `base64`, and `base64url` input is ignored, so wrapped MIME and PEM bodies decode as-is
- Decode returns `result` as `utf8` text unless `outputEncoding` asks for `hex` or `base64`, which returns the bytes losslessly and transcodes between encodings; malformed input fails as `decode_failed`, and binary bytes as `decode_not_utf8` rather than with replacement characters

---

### `toolkit_geolocate_ip` <sub>tool</sub>

- `target` is an IPv4/IPv6 address or a dotted hostname, DNS-resolved first; private or reserved addresses fail as `private_target`, unresolvable hostnames as `unresolvable_host`
- Returns `country`, `countryCode`, `region`, `city`, `latitude`/`longitude`, `asn`, `org`, and `timezone` with `resolvedIp` and `source`; a `true` in `proxy`, `hosting`, or `mobile` means the location describes infrastructure, not a person
- Keyless ip-api free tier over plaintext HTTP by default (`TOOLKIT_GEO_BASE_URL`, `TOOLKIT_GEO_API_KEY`); results are cached per resolved IP and provider calls are rate-limited

---

### `toolkit_check_network` <sub>tool</sub>

- `mode` is `ping`, `traceroute`, `connectivity`, or `public_ip`; `target` is required except for `public_ip`, and `port` (1–65535) for `connectivity`; `count` 1–10 pings (default 3), `timeoutMs` 100–30000 (default 3000)
- A silent host is `reachable: false`, not an error; `ping` adds `rttMs`, `sent`, `received`, and `packetLossPercent`, `connectivity` adds `outcome` (`open`, `refused`, `timeout`, `unreachable`), and `traceroute` returns `hops`; an unresolvable host or a ping/traceroute binary that can't run fails as `unreachable`
- Registered only when `TOOLKIT_ENABLE_NET_DIAGNOSTICS=true`; private and reserved targets fail as `private_target_blocked` unless `TOOLKIT_ALLOW_PRIVATE_NETWORK=true`

---

### `toolkit_check_system` <sub>tool</sub>

- `what` is `os`, `cpu`, `memory`, `load`, or `interfaces`; exactly one matching facet object is populated
- `memory.availableBytes` is the allocation headroom and `limitBytes` appears under a container memory limit; `totalBytes`, `freeBytes`, and `usedBytes` are raw OS figures that count reclaimable cache as used
- Registered only when `TOOLKIT_ENABLE_SYSTEM_INFO=true`, since `os` and `interfaces` disclose host topology and version details

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Toolkit-specific:

- Hashing, ID minting, QR encoding, and encode/decode run in-process on `node:crypto` and the `qrcode` library, with no upstream calls
- Geolocation calls the provider, never the target, and checks the DNS-resolved IP against private ranges, so a hostname can't reach an internal address
- Fail-closed gating: `toolkit_check_network` and `toolkit_check_system` are absent from `tools/list` unless enabled. Both report on the server's host, not the caller's, so they belong on local or self-hosted deployments
- Two-tier network gate: with diagnostics on, private, loopback, link-local, and reserved targets (the cloud-metadata endpoint included) stay blocked until `TOOLKIT_ALLOW_PRIVATE_NETWORK=true`

Agent-friendly output:

- Provenance: geolocation echoes `resolvedIp` and `source`, and omits fields the provider didn't report instead of inventing them
- Response shaping: provider strings are capped at 256 characters and stripped of control characters, so registry-controlled text like `org` can't flood or format a model's context
- Discriminated outputs: `operation`, `format`, `mode`, and `what` echo what ran, and only that branch's fields are populated
- Typed failures: every declared failure carries a `reason` and a recovery hint, and conflicting inputs (`expected` with `generate`, `outputEncoding` with `encode`) are rejected by name, not ignored

## Getting started

### Public Hosted Instance

A public instance is available at `https://toolkit.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "toolkit-mcp-server": {
      "type": "streamable-http",
      "url": "https://toolkit.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. No API key is required.

```json
{
  "mcpServers": {
    "toolkit-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/toolkit-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "toolkit-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/toolkit-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "toolkit-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/toolkit-mcp-server:latest"]
    }
  }
}
```

To enable the gated host-probing tools, add their flags to `env` (or `-e` for Docker):

```json
"env": {
  "MCP_TRANSPORT_TYPE": "stdio",
  "TOOLKIT_ENABLE_NET_DIAGNOSTICS": "true",
  "TOOLKIT_ENABLE_SYSTEM_INFO": "true"
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key needed — geolocation uses the keyless [ip-api](https://ip-api.com/) free tier by default.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/toolkit-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd toolkit-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

## Configuration

All variables are optional.

| Variable | Description | Default |
|:---|:---|:---|
| `TOOLKIT_ENABLE_NET_DIAGNOSTICS` | Register the gated `toolkit_check_network` tool. Leave off for hosted or shared deployments. | `false` |
| `TOOLKIT_ENABLE_SYSTEM_INFO` | Register the gated `toolkit_check_system` tool. | `false` |
| `TOOLKIT_ALLOW_PRIVATE_NETWORK` | With network diagnostics on, permit private, reserved, loopback, and link-local targets. | `false` |
| `TOOLKIT_GEO_API_KEY` | API key for the geolocation endpoint, if it requires one. | none |
| `TOOLKIT_GEO_BASE_URL` | Base URL for an ip-api-compatible endpoint. The keyless default is plaintext HTTP; ip-api's HTTPS endpoint needs a paid key. | `http://ip-api.com` |
| `TOOLKIT_GEO_CACHE_TTL_SECONDS` | In-memory geolocation cache TTL in seconds. | `3600` |
| `TOOLKIT_GEO_RATE_LIMIT_PER_MIN` | Max geolocation provider requests per minute; cache hits don't count, and excess requests fail with a retryable rate-limit error. | `45` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. The server declares `stateless`; an explicit value overrides it. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security, changelog sync
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t toolkit-mcp-server .
docker run --rm -p 3010:3010 toolkit-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/toolkit-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers the five always-on tools, and the two gated tools only behind their flags. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Seven tools, five always-on and two gated. |
| `src/services/geo` | Geolocation service — DNS resolution, provider call with retry, normalization, in-memory cache. |
| `src/services/network` | Network-diagnostic service plus the shared target schema and private-range classifier. |
| `tests/` | Vitest suites for tools (`tests/tools`) and services (`tests/services`). |

## Development guide

See [`CLAUDE.md` / `AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools in the `createApp()` arrays in `src/index.ts`; a host-probing tool registers only behind an enable flag
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
