<div align="center">
  <h1>@cyanheads/toolkit-mcp-server</h1>
  <p><b>Generate random IDs, QR codes, and hashes, encode and decode values, and geolocate IPs, plus gated network and system diagnostics, via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-2.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/toolkit-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/toolkit-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/toolkit-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

A standalone developer-utilities server — the five always-on tools need no upstream API: generate identifiers, QR codes, and cryptographic digests, encode and decode values, and geolocate a public IP or hostname. Two more tools report diagnostics about the server's own host, gated off by default. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `toolkit_hash_value` | Generate a cryptographic digest (sha256/sha384/sha512/sha1/md5) as hex, base64, or SRI, or constant-time-compare a value against an expected digest. |
| `toolkit_generate_id` | Mint cryptographically-random identifiers — UUIDv4, UUIDv7, or ULID — singly or in batches up to 1000. |
| `toolkit_generate_qr` | Encode text or a URL into a QR code as SVG markup, base64 PNG, or a terminal-renderable string. |
| `toolkit_encode_value` | Encode or decode a value across base64, base64url, hex, or URL percent-encoding, in either direction. |
| `toolkit_geolocate_ip` | Resolve a public IP or hostname to geographic and network metadata — country, city, coordinates, ASN, timezone. |
| `toolkit_check_network` | **Gated, off by default.** Read-only network diagnostics from the server host — ping, traceroute, TCP connectivity, or egress-IP detection. |
| `toolkit_check_system` | **Gated, off by default.** Report a facet of the server host's system state — OS, CPU, memory, load average, or network interfaces. |

## Capability reference

### `toolkit_hash_value` <sub>tool</sub>

- `operation`: `generate` (a digest) or `compare` (timing-safe check via `timingSafeEqual`); omitted, it compares when `expected` is sent and generates otherwise. `generate` sent together with `expected` is rejected with a typed `expected_without_compare` error rather than ignoring `expected`
- Algorithms: `sha256` (default), `sha384`, and `sha512` for security; `sha1` and `md5` are exposed for checksum and file-integrity compatibility only — never for passwords or signatures
- `digestEncoding` sets the generated digest's form: `hex` (lowercase, default), `base64`, or `sri` (`sha512-<base64>`, the npm lockfile `integrity` and Subresource Integrity form — sha256/sha384/sha512 only)
- `expected` is accepted as hex, base64, or SRI, recognized by its shape at the algorithm's digest length, so a published checksum is pasted as-is. An SRI value may hold several space-separated entries, as an npm `integrity` field can: entries for other algorithms are skipped, and it matches when any entry for `algorithm` does
- Typed errors separate an unrecognizable digest (`expected_malformed`), one of the wrong length (`expected_length_mismatch`, whose hint names the algorithm that length belongs to), and an SRI value with no entry for `algorithm` (`expected_algorithm_mismatch`)
- `inputEncoding` reads `value` as `utf8` (default), `hex`, or `base64`, so binary blobs skip a decode round-trip
- Canonical use: match a download against a vendor-published checksum or a lockfile integrity entry

---

### `toolkit_generate_id` <sub>tool</sub>

- `type`: `uuid_v4` (random, default), `uuid_v7` (time-ordered, sortable by creation), or `ulid` (26-char Crockford base32, lexicographically sortable)
- `count` mints a batch up to 1000 in one call; the returned `ids` array always holds exactly `count` values
- `uuid_v7` and `ulid` batches are monotonic — strictly increasing even within the same millisecond — so `ids` stays in sorted creation order. Ids minted in the same millisecond are separated by random gaps (a 32-bit draw plus one), so no id in a batch is derivable from another; for `ulid` this departs from the spec's reference +1 increment on purpose
- Read-only — minting changes nothing — but never idempotent, so a client won't cache or deduplicate a batch

---

### `toolkit_generate_qr` <sub>tool</sub>

- `format`: `svg` (inline markup), `png_base64` (raster bytes with `mimeType` and `byteLength`), or `terminal` (plain Unicode half-blocks with no escape codes, fenced in `content[]`)
- `terminal` is drawn for a dark background: light modules, quiet zone included, are blocks and dark modules are spaces
- `errorCorrection` (L/M/Q/H) trades data capacity for damage tolerance; `margin` sets the quiet-zone width in modules for every format; `scale` sets pixels per module for `svg` (its `width`/`height`) and `png_base64`, so both are `(modules + 2 × margin) × scale` px per side
- The returned `version` (1–40) reflects how dense the encoded data is
- `png_base64` also arrives as an MCP image content block, so a client reading `content[]` can render the code without decoding `structuredContent`
- A rendered PNG is bounded at 2048 px per side — `(modules + 2 × margin) × scale` — so a dense symbol at a high `scale` is rejected with a typed `raster_too_large` error naming a scale that fits; `svg` and `terminal` are unbounded
- `data` is encoded as UTF-8 and capped at 2953 bytes — the absolute ceiling (version 40, level L, byte mode); a non-ASCII character takes 2–4 bytes, and usable capacity is lower at higher `errorCorrection` levels, so over-capacity input is rejected with a typed `data_too_large` error that reports the payload's byte count

---

### `toolkit_encode_value` <sub>tool</sub>

- `encoding`: `base64`, `base64url` (URL-safe alphabet), `hex`, or `url` (percent-encoding)
- `operation`: `encode` (raw UTF-8 → encoding) or `decode` (encoded value → bytes)
- `outputEncoding` (decode only) returns the recovered bytes as `utf8` text (when omitted), `hex`, or `base64` — lossless for binary data, and a direct transcode between encodings (a base64 digest to hex, for example). Sent with `encode`, it is rejected with a typed `output_encoding_not_applicable` error
- Decode never substitutes replacement characters: bytes that aren't valid UTF-8 return a typed `decode_not_utf8` error pointing at `outputEncoding`, and a leading byte-order mark is kept
- Whitespace in `hex`, `base64`, and `base64url` input is ignored, so line-wrapped MIME and PEM bodies decode as-is (without PEM's `-----BEGIN/END-----` lines, which aren't base64); a `url` value is taken literally
- Malformed decode input returns a typed `decode_failed` error with a recovery hint, not a silent best-effort

---

### `toolkit_geolocate_ip` <sub>tool</sub>

- Returns country, region, city, latitude/longitude, ASN, owning organization, and timezone
- `proxy`, `hosting`, and `mobile` flag when the address is a proxy/VPN/Tor exit, a datacenter network, or a mobile carrier — a `true` on any of them means the coordinates describe infrastructure, not a person. Absent when the provider doesn't report them
- A hostname is DNS-resolved first; `resolvedIp` echoes the IP actually located, and `source` names the answering provider
- SSRF-free — the server calls the provider, never the target; the resolved IP is re-checked against private ranges, and private/reserved addresses are rejected (they have no public geolocation)
- Best-effort and provider-bounded: VPNs, proxies, mobile NAT, and anycast all defeat IP-to-location, accuracy is city-level at best, and absent fields are reported as unknown rather than invented
- Provider-supplied strings are truncated and stripped of control characters before they reach the response, so registry-controlled text (`org`, `isp`, `as`) cannot flood or format a model's context
- Keyless by default (ip-api free tier, which is plaintext HTTP — see `TOOLKIT_GEO_BASE_URL`); results are cached in memory by resolved IP under a fixed entry cap

---

### `toolkit_check_network` <sub>tool</sub>

- **Gated** — registered only when `TOOLKIT_ENABLE_NET_DIAGNOSTICS=true`; absent from `tools/list` otherwise
- `mode`: `ping` (ICMP round-trip), `traceroute` (hop path to the target), `connectivity` (raw TCP connect to `target` on `port`), or `public_ip` (the host's own egress IP)
- A host that does not respond is reported as `reachable: false` — a valid result, not an error
- Diagnoses the **server's** own network, so it is useful on a local or self-hosted deployment; reaching a private/reserved/internal target additionally requires `TOOLKIT_ALLOW_PRIVATE_NETWORK=true`, which keeps the cloud-metadata endpoint blocked by default

---

### `toolkit_check_system` <sub>tool</sub>

- **Gated** — registered only when `TOOLKIT_ENABLE_SYSTEM_INFO=true`; absent from `tools/list` otherwise
- `what`: `os`, `cpu`, `memory`, `load`, or `interfaces`
- Exactly one facet object is populated per call, matching `what`
- Describes the host this server runs on, **not** the calling client — meaningful on a local or self-hosted deployment; gated off by default because `os` and `interfaces` disclose host topology and version details

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Toolkit-specific:

- Local, pure-compute core — hashing, ID minting, QR encoding, and value encode/decode run entirely in-process via `node:crypto` and the `qrcode` library; no upstream calls
- `toolkit_geolocate_ip` is the one keyless-by-default network call (ip-api free tier, optional `TOOLKIT_GEO_API_KEY`); the server calls the provider directly and re-checks the DNS-resolved IP against private ranges, so a hostname can't smuggle a request to an internal address
- Fail-closed gating — the two host-probing tools (`toolkit_check_network`, `toolkit_check_system`) are absent from `tools/list` unless explicitly enabled, so a hosted instance exposes no SSRF or info-disclosure surface by default
- Two-tier network gate — even with diagnostics enabled, private/reserved/loopback/link-local targets (including the cloud-metadata endpoint) stay blocked until a second flag permits them
- Bounded inputs — QR `data` capped at 2953 bytes, rendered PNGs capped at 2048 px per side, ID batches capped at 1000; CSPRNG-backed primitives with constant-time hash comparison via `timingSafeEqual`

Agent-friendly output:

- Provenance — geolocation echoes `resolvedIp` (the IP actually located) and `source` (the answering provider); absent upstream fields are reported as unknown, never invented
- Response shaping — provider-supplied strings (`org`, `isp`, `as`) are length-bounded and stripped of control characters before they reach the response, so untrusted registry text can't flood or format a model's context
- Discriminated output contracts — `operation`, `format`, `mode`, and `what` fields echo back exactly what ran, with only the branch-relevant fields populated per call; an unreachable host in `toolkit_check_network` reports `reachable: false` as valid data, not an error
- Typed failure reasons — decode, hashing, QR, geolocation, and network failures each carry a structured `reason` plus a next-step recovery hint (e.g. `decode_not_utf8`, `expected_malformed`, `raster_too_large`, `private_target_blocked`); `expected` sent with `generate`, and `outputEncoding` sent with `encode`, are rejected by name rather than silently ignored

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

Add the following to your MCP client configuration file. No API key is required — the five always-on tools and the default keyless geolocation tier work out of the box.

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

Every variable is optional. Server-specific options are validated at startup via the Zod schema in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---|:---|:---|
| `TOOLKIT_ENABLE_NET_DIAGNOSTICS` | Register the gated `toolkit_check_network` tool. Leave off for hosted or shared deployments. | `false` |
| `TOOLKIT_ENABLE_SYSTEM_INFO` | Register the gated `toolkit_check_system` tool. Meaningful only on a local or self-hosted deployment. | `false` |
| `TOOLKIT_ALLOW_PRIVATE_NETWORK` | With network diagnostics on, permit private/reserved/loopback targets. The second explicit gate. | `false` |
| `TOOLKIT_GEO_API_KEY` | API key for the geolocation endpoint, if it requires one. | none |
| `TOOLKIT_GEO_BASE_URL` | Base URL for an ip-api-compatible geolocation endpoint. The default is plaintext HTTP — ip-api's HTTPS endpoint is not part of the keyless free tier and answers `403 SSL unavailable for this endpoint` without a paid key. Point this at an HTTPS endpoint (with `TOOLKIT_GEO_API_KEY`) to encrypt the provider request. | `http://ip-api.com` |
| `TOOLKIT_GEO_CACHE_TTL_SECONDS` | In-memory geolocation cache TTL in seconds. | `3600` |
| `TOOLKIT_GEO_RATE_LIMIT_PER_MIN` | Max geolocation requests per minute. | `45` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_SESSION_MODE` | `auto`, `stateful`, or `stateless`. No tool requests multi-round input. `auto` is the framework schema default and resolves to `stateful`, but with `MCP_SESSION_MODE` unset the server resolves `stateless` from `createApp({ sessionMode })`; an explicit `MCP_SESSION_MODE` value still overrides it. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

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
docker run --rm -e MCP_TRANSPORT_TYPE=http -p 3010:3010 toolkit-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/toolkit-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services, with fail-closed gating for the two host-probing tools. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Seven tools — five always-on, two gated. |
| `src/services/geo` | Geolocation service — DNS resolution, provider call with retry/backoff, normalization, in-memory cache. |
| `src/services/network` | Network-diagnostic service plus the shared target validator and private-range classifier. |
| `tests/` | Unit and integration tests mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md` / `AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools in the `createApp()` arrays in `src/index.ts`
- The two host-probing tools register behind their enable-flags; the network target gate validates after DNS resolution — never fabricate a result for an unlocatable or unreachable target

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
