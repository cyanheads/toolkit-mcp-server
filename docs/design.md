# toolkit-mcp-server — Design

A from-scratch rebuild of the legacy v1.0.1 `toolkit-mcp-server` on mcp-ts-core: a small grab-bag of system and developer utilities, redesigned **fail-closed**. The always-safe tools register everywhere; the two groups that are unsafe on a shared host (network diagnostics, system monitoring) are **off by default behind enable-gates**, so the hosted deployment exposes only what carries no SSRF or info-disclosure risk.

This doc formalizes `docs/idea.md` into a buildable spec. The tool names are fixed — seven tools, five always-on and two gated.

---

## MCP Surface

### Tools

| Tool | Summary | readOnlyHint | openWorldHint | Key inputs | Output shape |
|---|---|---|---|---|---|
| `toolkit_hash_value` | Generate a digest or HMAC, or constant-time-compare a value against an expected digest. | `true` | `false` | `operation` (`generate`\|`compare` — omitted resolves to `compare` when `expected` is sent, else `generate`), `value`, `algorithm` (`sha256`\|`sha384`\|`sha512`\|`sha1`\|`md5`), `digestEncoding` (`hex`\|`base64`\|`base64url`\|`sri` — default `hex`, generate only; `sri` not with `secret`), `expected` (hex, base64, or base64url, bare or `<algorithm>:`/`<algorithm>=`-prefixed; one or more SRI entries; or one checksum-file line; compare only), `inputEncoding` (`utf8`\|`hex`\|`base64` — default `utf8`), `secret` (HMAC key; empty counts as absent), `secretEncoding` (`utf8`\|`hex`\|`base64`\|`base64url` — default `utf8`) | `{ algorithm, operation, hmac?, digest?, matches?, lengthInBytes? }` |
| `toolkit_generate_id` | Mint cryptographically-random identifiers (UUIDv4/UUIDv7/ULID), single or batch. | `true`¹ | `false` | `type` (`uuid_v4`\|`uuid_v7`\|`ulid`), `count` | `{ type, ids[], count }` |
| `toolkit_generate_qr` | Encode text/URL into a QR code as SVG markup, base64 PNG bytes, or a terminal-renderable string. | `true` | `false` | `data`, `format` (`svg`\|`png_base64`\|`terminal`), `errorCorrection`, `margin`, `scale` | `{ format, content, mimeType?, byteLength?, version }` |
| `toolkit_encode_value` | Encode or decode a value across base64 / base64url / hex / URL. | `true` | `false` | `operation` (`encode`\|`decode`), `encoding`, `value`, `outputEncoding` (`utf8`\|`hex`\|`base64`\|`base64url` — decode only; omitted means `utf8`) | `{ encoding, operation, outputEncoding?, result }` |
| `toolkit_geolocate_ip` | Resolve public IPs or hostnames to geographic and network metadata via an external geo API. | `true` | `true` | One `target` or ordered `targets` (maximum 1000) | Scalar `GeoResult` (see Data Model); batch `{ results, failedCount, unprocessedTargets }`, first 100 positions served |
| `toolkit_check_network` | **Gated.** Network diagnostics — ping, traceroute, TCP connectivity, or host IPv4 egress-IP detection. | `true` | `true` | `mode` (`ping`\|`traceroute`\|`connectivity`\|`public_ip`), `target` (required for all modes except `public_ip`), `port` (connectivity only), `count`, `timeoutMs`, `family` (`4`\|`6`, ignored for `public_ip`) | `{ mode, target?, resolvedIp?, reachable?, outcome?, rttMs?, sent?, received?, packetLossPercent?, hops?, publicIp? }` |
| `toolkit_check_system` | **Gated.** Host system facts — OS, CPU, memory, load average, or network interfaces. | `true` | `false` | `what` (`os`\|`cpu`\|`memory`\|`load`\|`interfaces`) | `{ what, ...facetFields }` |

¹ `toolkit_generate_id` is `readOnlyHint: true` — minting draws from the CSPRNG and returns it, modifying nothing — paired with `idempotentHint: false`, since each call produces fresh non-reproducible entropy (the whole point) and must not be cached or deduplicated. It performs no external I/O, so `openWorldHint: false`.

**Gated tools register conditionally.** `toolkit_check_network` registers only when `TOOLKIT_ENABLE_NET_DIAGNOSTICS=true`; `toolkit_check_system` only when `TOOLKIT_ENABLE_SYSTEM_INFO=true`. When a flag is off the tool is **absent from `tools/list`** — invisible, not present-and-erroring (see Design Decisions: fail-closed).

### Resources

None in v1 beyond the published skill below. Every capability is an action (compute / mint / probe), not a stable addressable entity — there is no `toolkit://thing/{id}` that an agent would inject as context. A geolocation result is a live lookup, not a durable record. Resources add nothing a tool-only client can't already reach.

### Prompts

None in v1. The tools are self-explanatory single actions with no recurring multi-step interaction pattern worth templating.

### Skill

`skills/toolkit-guide/SKILL.md`, served through the Skills extension (`createApp({ skills: 'skills' })`) as `skill://toolkit-guide/SKILL.md`, carries the gates the tool descriptions don't: reading a digest or signature mismatch, webhook and JWT signing inputs, moving digest bytes between encodings, who runs an IP's network, and host diagnostics. The server `instructions` name it and carry what a client that never loads it still needs.

---

## Overview

`toolkit-mcp-server` gives an agent (and its human) a handful of quick utilities without leaving the conversation: hash a value, mint IDs, make a QR code, locate an IP. It wraps no single product API — it is mostly an **internal-capability** server (Node crypto, `os`/`process`, pure string transforms) with **one external dependency among its always-on tools** (an IP-geolocation API); the gated `toolkit_check_network` also goes out, to the hosts it probes and to an egress-IP echo service.

The honest framing carried from the design thread: a utility server fights an agent-self-serve headwind. A code-capable agent hashes a string or base64s a blob inline in its sandbox. The tools that *durably* earn a call are the ones the model **can't** self-serve:

1. **ID generation** — real CSPRNG entropy. A language model is a poor RNG; "make me a random UUID" produced by the model is not random.
2. **QR generation** — artifact bytes (PNG/SVG) the model cannot type out.
3. **IP geolocation** — external data the model doesn't have.

Hash, encode, and compare are kept because they are cheap, complete the set, and have genuine value in **chat clients with no code sandbox** (Claude Desktop, mobile) where the model can't self-serve either. Lead the README and tool descriptions with ID-gen and QR, not hashing.

The network and system tools serve **local-deployment operators** running diagnostics on their own machine/network — which is exactly why they are gated off when the server is hosted on a shared host, where the same capability becomes an SSRF / internal-recon / info-disclosure vector.

Primary agent workflows: "give me 5 ULIDs for these records", "turn this URL into a scannable QR", "where is `203.0.113.7` and who owns it", "verify this download matches the vendor's published SHA-256", and (local only) "can this box reach `db.internal:5432`".

---

## Requirements

**Functional**

- Five always-on tools register on every transport and every deployment with zero configuration: `toolkit_hash_value`, `toolkit_generate_id`, `toolkit_generate_qr`, `toolkit_encode_value`, `toolkit_geolocate_ip`.
- Two gated tools register only when their enable-flag is set: `toolkit_check_network`, `toolkit_check_system`.
- Hashing supports sha256 (default), sha384, sha512, sha1, md5. `compare` is **constant-time** (`crypto.timingSafeEqual`). md5/sha1 are exposed for checksum compatibility and for verifying existing HMAC-SHA1 signatures only, and the description must say so. A non-empty `secret` makes the digest `HMAC(algorithm, secret, value)` for generate and compare alike, read per `secretEncoding` (`utf8` default | `hex` | `base64` | `base64url`, the last for a JWK `k`); the output then carries `hmac: true`, and the secret never appears in output, error messages, or `ctx.log`. That covers webhook signatures (GitHub `X-Hub-Signature-256` pastes as `expected` as-is) and HS256 JWT signatures; JWT parsing and asymmetric signatures stay out of scope. `inputEncoding` (`utf8` default | `hex` | `base64`) controls how `value` is interpreted before hashing — necessary so the agent can hash raw binary data supplied as hex or base64 without round-tripping through a decode step. `digestEncoding` (`hex` default | `base64` | `base64url` | `sri`) sets the generated digest's form, `base64url` being unpadded (RFC 4648 §5, the JWS signature encoding) and `sri` refused with a secret, since SRI carries plain digests; `expected` is recognized by shape at the algorithm's digest length — hex, base64, or base64url, bare or `<algorithm>:`/`<algorithm>=`-prefixed; SRI; or one checksum-file line as `sha256sum`, `shasum`, `md5`, or `openssl dgst` prints it — since published digests arrive in every one of those forms (npm lockfile `integrity`, Subresource Integrity, `Content-MD5`, `x-amz-checksum-sha256`, `SHA256SUMS` lines, OCI and GitHub release-asset `sha256:` digests).
- ID generation uses the platform CSPRNG for all three types and supports batch via `count` (Zod `.max(1000)` — large enough for any realistic batch, small enough to keep the response inline without truncation).
- QR generation emits SVG (text, sized `(modules + 2 × margin) × scale` px), base64-encoded PNG, or a terminal string of plain Unicode half-blocks, with configurable error-correction level, quiet-zone margin, and module scale.
- Encoding covers base64, base64url, hex, URL — both directions. Decode is byte-preserving: `outputEncoding` returns the recovered bytes as UTF-8 text (default, fatal on invalid UTF-8), hex, base64, or unpadded base64url (RFC 4648 §5, the form JWK members, JWS signatures, and PKCE `code_challenge` use), so binary payloads and digests transcode without loss. Whitespace in hex/base64/base64url input is ignored.
- Geolocation accepts an IP **or** a hostname, resolves to country/region/city, lat/lon, ASN, AS holder and name, org, ISP, timezone, and reports its `source` provider. It is cached and rate-limited.
- `toolkit_check_network` supports `ping`, `traceroute`, `connectivity` (TCP reachability — host via `target`, port via separate `port` param, not inline `host:port` syntax), and `public_ip` (host IPv4 egress IP; the echo service has no IPv6 address, so it can't show whether IPv6 egress works — `target` is absent/ignored for this mode). A hostname resolves once with `lookup(target, { all: true })`; an IP literal skips resolution. An optional `family` (`4`|`6`) filters that set after resolution, never in the lookup (Node on macOS answers `{ family: 6 }` for an IPv4-only name with an IPv4-mapped `::ffff:` address), and an empty filtered set fails as `family_mismatch`. Private/reserved/loopback/link-local addresses are then dropped unless `TOOLKIT_ALLOW_PRIVATE_NETWORK=true`, and `private_target_blocked` fires only when none remain, so a hostname mixing public and private addresses is probed on its public ones and never contacts the rest. With that flag off, no error message names a private/reserved address the resolver returned: `family_mismatch` lists a hostname's public addresses and counts the others, and `private_target_blocked` only counts them, since the server's resolver can return private answers the caller cannot see. An IP literal is the caller's own input and is echoed. The remaining addresses are tried in turn, alternating families and leading with the family of the first (RFC 8305 §4); every attempt is handed an address, never the hostname, so nothing re-resolves past the guard (no `autoSelectFamily`). `connectivity` moves on after `refused` or `unreachable` and spends `timeoutMs` once across all attempts, so an attempt that times out is the last; `ping` and `traceroute` move on only when the binary produced no result for an address, and share one spawn deadline, the longest a single address would get. `resolvedIp` names the address whose result is reported. `ping` derives packet counts from Unix summaries; on Windows it takes sent count from the summary and counts timed echo replies, including IPv6 replies without TTL, because the summary also counts ICMP failure replies. `connectivity` reports an `outcome` (`open` | `refused` | `timeout` | `unreachable`) and, when open, the connect time as `rttMs`. On macOS/BSD an IPv6 address runs `ping6`/`traceroute6`, since their `ping`/`traceroute` reject IPv6; Linux and Windows use one binary for both families.
- `toolkit_check_system` reports host OS, CPU, memory, load, or interfaces. OS names the runtime (`runtime`: `bun` | `node`, `runtimeVersion`) beside `nodeVersion`, which under Bun is the Node.js API level Bun implements. Memory carries `availableBytes` (headroom for new allocations, the same figure under Bun and Node) and, inside a container, `limitBytes`, alongside the raw OS `totalBytes`/`freeBytes`/`usedBytes`.

**Non-functional**

- **Fail-closed.** Enable-flags default `false`. The hosted profile sets none → only the five always-on tools exist.
- **Two-tier network gate.** Even with net-diag enabled, private/reserved destinations need the second explicit `TOOLKIT_ALLOW_PRIVATE_NETWORK` gate. This blocks the cloud-metadata endpoint (`169.254.169.254`) and internal-`10.x`/`172.16/12`/`192.168` recon vectors.
- **Range coverage is a denylist for IPv4 and an allowlist for IPv6.** IPv4 enumerates the IANA special-use blocks; IPv6 admits only `2000::/3` minus the special-use blocks carved out of it (6to4, Teredo, ORCHID/ORCHIDv2, documentation, benchmarking), so unallocated and future-assigned space classifies as reserved instead of slipping through a forgotten denylist entry. IPv4-mapped addresses are classified by their embedded IPv4 in either the dotted (`::ffff:127.0.0.1`) or hex (`::ffff:7f00:1`) spelling.
- **Bun and Node, no Workers build.** One entry point, `src/index.ts`, serves both runtimes. `toolkit_check_network` (raw sockets, the ping/traceroute binaries) and `toolkit_check_system` (`os`/`process`) are **Node-only**: they need `node:` built-ins, which Bun implements and a Workers isolate lacks.
- **Resilience scoped to geolocation.** It gets retry/backoff/cache; the other always-on tools are local and synchronous, and the gated `toolkit_check_network`, which probes its targets and calls an egress-IP echo for `public_ip`, has no resilience layer.
- **Zero-config hosted profile.** Pick a keyless-tier geo provider (ip-api class) so the hosted deployment needs no API key.
- Every tool input field carries `.describe()`; format constraints live in Zod validators (regex/enum/min/max), not just prose. JSON-Schema-serializable types only.
- `format()` is content-complete on every tool (markdown twin of `structuredContent`).

**Out of scope (the drop line)**

Bulk port-scanning, arbitrary-command exec, and arbitrary-URL fetch do **not** belong here at any gate — offensive/recon net work lives in `pentest-mcp-server` under its authorized-use framing. Gating beats deletion only because each gated tool is legitimately useful on a *local* deployment; the dropped capabilities are useful nowhere in this server's purpose.

---

## Data Model

No persistent entities — the server holds no durable records, so there is no opaque-ID lifecycle for an agent to navigate. Inputs are self-supplied (a string to hash, data to encode) or a single network identifier (an IP/hostname the agent already has). The "identifiers" the server deals in are well-known public formats, not server-minted handles:

```ts
/** Hash result. `digest` follows `digestEncoding`; `matches` only on operation:'compare'. */
type HashResult = {
  algorithm: 'sha256' | 'sha384' | 'sha512' | 'sha1' | 'md5';
  operation: 'generate' | 'compare';  // resolved: an omitted operation is reported as what ran
  hmac?: true;              // present when a non-empty `secret` keyed the digest
  digest?: string;          // generate: lowercase hex, base64, unpadded base64url, or `<algorithm>-<base64>`
  matches?: boolean;        // compare: constant-time equality result
  lengthInBytes?: number;   // digest byte length (32 for sha256, 48 for sha384, 64 for sha512, …)
};

/** Generated identifiers — minted, not looked up. */
type IdResult = {
  type: 'uuid_v4' | 'uuid_v7' | 'ulid';
  ids: string[];            // length === count
  count: number;
};

/** QR artifact. `content` is the SVG/terminal string, or base64 for png_base64. */
type QrResult = {
  format: 'svg' | 'png_base64' | 'terminal';
  content: string;
  mimeType?: 'image/svg+xml' | 'image/png';  // absent for terminal
  byteLength?: number;      // decoded byte size for png_base64
  version: number;          // QR symbol version (1–40), reflects data density
};

/** Encode/decode result. */
type EncodeResult = {
  encoding: 'base64' | 'base64url' | 'hex' | 'url';
  operation: 'encode' | 'decode';
  outputEncoding?: 'utf8' | 'hex' | 'base64' | 'base64url';  // decode only: how `result` renders the bytes
  result: string;
};

/**
 * Network diagnostic result. Fields are mode-conditional — not all are present
 * in every mode. `target` is absent for `public_ip` (no target supplied).
 * `reachable` is absent for `traceroute` (hop visibility is the metric, not binary reach).
 * `publicIp` is only present for `public_ip`.
 */
type CheckNetworkResult = {
  mode: 'ping' | 'traceroute' | 'connectivity' | 'public_ip';
  target?: string;           // absent for public_ip
  resolvedIp?: string;       // ping, traceroute, connectivity: the address whose result is reported
  reachable?: boolean;       // ping + connectivity: false is a valid result, not an error
  outcome?: 'open' | 'refused' | 'timeout' | 'unreachable';  // connectivity
  rttMs?: number;            // ping: average echo time; connectivity: connect time, only when open
  sent?: number;             // ping, reachable or not: echo requests transmitted
  received?: number;         // ping: echo replies received
  packetLossPercent?: number; // ping: 0–100, one decimal, computed from sent/received
  hops?: Array<{ hop: number; address: string; rttMs?: number }>;  // traceroute
  publicIp?: string;         // public_ip: the host's IPv4 egress IP as seen by the external probe
};

/**
 * Geolocation. Upstream is sparse — many fields are nullable for reserved
 * ranges, unrouted IPs, or providers that omit ASN on the free tier.
 * Normalization preserves uncertainty; never fabricate from a missing field.
 */
type GeoResult = {
  target: string;           // as supplied (IP or hostname)
  resolvedIp: string;       // hostname resolved to this IP before lookup
  country?: string;         // ISO 3166-1 country name
  countryCode?: string;     // ISO 3166-1 alpha-2 country code
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  asn?: string;             // e.g. "AS15169"
  asHolder?: string;        // holder name after the ASN in ip-api `as`, e.g. "Cloudflare, Inc."
  asName?: string;          // ip-api `asname`, the registry's AS name, e.g. "CLOUDFLARENET"
  org?: string;             // ip-api `org`, else asHolder, else isp; e.g. "Google LLC"
  isp?: string;             // ip-api `isp`, e.g. "Cloudflare, Inc"
  timezone?: string;        // IANA, e.g. "America/Los_Angeles"
  proxy?: boolean;          // known proxy, VPN, or Tor exit
  hosting?: boolean;        // hosting or datacenter network
  mobile?: boolean;         // mobile carrier network
  source: string;           // provider that answered, e.g. "ip-api"
};
```

Every provider string is stripped of control characters and of the bidirectional embedding, override, and isolate controls (U+202A–U+202E, U+2066–U+2069), which can make registry text display reordered, then capped at 256 characters, before it is cached or returned. A control run becomes one space; a bidirectional control is removed outright, since it is invisible formatting, and the U+200E/U+200F marks that RTL names use are kept. Absent and empty provider values stay absent.

**Network identifiers.** Targets are caller-supplied IPv4/IPv6/hostnames — validated by Zod via `z.union([z.ipv4(), z.ipv6(), z.string().regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/)])` (covers both raw IPs and valid hostnames; rejects bare single-label strings that could alias metadata endpoints). Never minted here. The agent obtains them from its own context (a log line, a URL, a prior tool); the server adds no resolver step beyond `geolocate`/`check_network` doing their own DNS. The private-range guard runs **after** DNS resolution so a hostname can't smuggle a private IP past the Zod validator.

---

## Services

The surface is overwhelmingly internal capability backed by Node builtins — only one true service.

| Service | Wraps | Key methods | Used by |
|---|---|---|---|
| `GeoService` | One external IP-geolocation API (keyless ip-api class by default; provider/key overridable) | `lookup(target, ctx): Promise<GeoResult>` and `lookupBatch(targets, ctx): Promise<GeoBatchResult>` — resolve and guard each target, reuse the IP-keyed TTL cache, normalize sparse provider results, and preserve batch positions and remainder | `toolkit_geolocate_ip` |

Everything else needs **no service** — pure functions over Node builtins, invoked directly from the handler:

- **Hashing / compare** → `node:crypto` (`createHash`, `timingSafeEqual`). No shared state.
- **ID generation** → `node:crypto.randomUUID()` (v4), a UUIDv7 generator, and a ULID generator (both small, deterministic given the CSPRNG seed). One tiny dependency or inline implementation; no service.
- **QR generation** → a QR-encode library (e.g. `qrcode`) producing SVG string / PNG buffer; `terminal` rendered from the module matrix. Pure compute, no service.
- **Encoding** → `Buffer` (base64/base64url/hex) and `encodeURIComponent`/`decodeURIComponent` (URL). No service.
- **Network diagnostics** → `node:net`/`node:dns` plus a ping/traceroute primitive. A thin `NetDiagService` is justified **only** to centralize the private-range guard (the two-tier gate must be enforced in one place, not duplicated per mode); it holds no resilience layer, and its one upstream is the egress-IP echo (`https://api.ipify.org`) that `public_ip` calls. Note: this is a **separate gate from the config-flag guard** — the config flag (`TOOLKIT_ENABLE_NET_DIAGNOSTICS`) controls *registration* at startup; the private-range guard fires at *request time* inside the registered handler. Do not conflate them.
- **System info** → `node:os` / `node:process`, plus, for the memory facet, the cgroup memory-usage file (`node:fs`) under a container limit and `vm_stat` (`node:child_process`) under Bun on macOS. Direct, no service.

**GeoService resilience** (the only always-on external dep):

| Concern | Decision |
|---|---|
| Retry boundary | Fetch + JSON parse are wrapped by `withRetry` from `/utils`; DNS failures are classified before the provider request. Provider 429 is never retried. |
| Backoff | 1–2 s base between retries of a failed lookup. |
| Rate limit | Independent fixed-window single/batch budgets (`TOOLKIT_GEO_RATE_LIMIT_PER_MIN=45`, `TOOLKIT_GEO_BATCH_RATE_LIMIT_PER_MIN=15`), fail-fast with `rate_limited`, seconds, and recovery. Cache hits are free. |
| HTTP check | `fetchWithTimeout` captures `X-Ttl`/`X-Rl` error headers. Provider 429 and successful `X-Rl: 0` set endpoint-local cooldowns; reset falls back to 60 seconds and is capped at one hour. Other HTTP failures are sanitized as `ServiceUnavailable`. |
| Parse classification | Detect provider error envelopes (`status: "fail"`) and throw the right code, not `SerializationError`. |
| Cache | In-memory TTL (default ~1 h) keyed by resolved IP — geolocation is stable, this absorbs repeat lookups and protects the rate budget. |
| Batch | Resolve targets sequentially and guard each IP, reuse cache, then POST eligible misses once to `/batch`. Preserve input positions including duplicates, expose errors and recovery per position, disclose every remainder past 100, reject more than 1000 before work. Malformed cardinality/status/query correlation never attaches another target's metadata. Caller cancellation rejects the call. |
| Provider failure prose | `status: "fail"` yields a server-authored `private_target` message, non-retryability, and recovery; the message names a hostname target, never the address it resolved to. Raw provider prose stays in process logging. Successful metadata retains its bounds. |

No DataCanvas: nothing here returns an analytical row set an agent would run SQL over. The largest payload is a single PNG/SVG string, handled inline.

---

## Config

Server-specific env vars live in `src/config/server-config.ts` as a lazy-parsed Zod schema (`parseEnvConfig`, mapping schema paths → env-var names). Booleans use `z.stringbool()` (so `=false` actually disables — `z.coerce.boolean()` can't be turned off).

| Env var | Required | Default | Effect |
|---|---|---|---|
| `TOOLKIT_ENABLE_NET_DIAGNOSTICS` | No | `false` | Registers `toolkit_check_network`. Off → tool absent from `tools/list`. |
| `TOOLKIT_ENABLE_SYSTEM_INFO` | No | `false` | Registers `toolkit_check_system`. Off → tool absent. |
| `TOOLKIT_ALLOW_PRIVATE_NETWORK` | No | `false` | (net-diag on) permits private/reserved/loopback/link-local targets — the **second** explicit gate. Off → such targets are rejected even with net-diag enabled. |
| `TOOLKIT_GEO_API_KEY` | No | — | API key, **if** the configured endpoint needs one. Absent → the keyless ip-api tier, rate-limited but fully functional. |
| `TOOLKIT_GEO_BASE_URL` | No | `http://ip-api.com` | Base URL for an **ip-api-compatible** endpoint — the request path and response shape are always ip-api's. Override to point at an ip-api pro endpoint or a self-hosted compatible one. The default is plaintext HTTP; ip-api's HTTPS endpoint requires a paid key. |
| `TOOLKIT_GEO_CACHE_TTL_SECONDS` | No | `3600` | GeoService cache TTL. |
| `TOOLKIT_GEO_RATE_LIMIT_PER_MIN` | No | `45` | Max geo-API requests per minute; excess requests are rejected with a retryable rate-limit error. Default matches the ip-api free tier (45 req/min). Raise when using a keyed or higher-tier provider. |
| `TOOLKIT_GEO_BATCH_RATE_LIMIT_PER_MIN` | No | `15` | Independent batch requests per minute; each serves up to 100 input positions. |

**One provider protocol.** There is no provider-selector variable: `GeoService` speaks ip-api and reports `source: "ip-api"` from a fixed literal, so provenance cannot be misstated by configuration. A second provider would arrive as an adapter layer with its own request/response mapping, and could reintroduce a constrained choice then.

**Degraded behavior without keys:** the default (`ip-api`, no key) is fully functional at the free rate limit. A key only raises the ceiling. Nothing else in the server takes config — the four pure-compute tools are zero-config by construction.

Standard framework env vars (`MCP_TRANSPORT_TYPE`, `MCP_HTTP_*`, `MCP_AUTH_MODE`, `MCP_LOG_LEVEL`) are unchanged from the scaffold.

**Packaging sync:** the gate flags and geo vars must be mirrored into `server.json` (`environmentVariables[]`) and `manifest.json` (`mcp_config.env` + `user_config`) — `lint:packaging` (run by devcheck) verifies the names match.

---

## Implementation Order

Each step is independently buildable and testable.

1. **Config** — `src/config/server-config.ts`: the gate flags + geo vars, lazy-parsed. Unit-test the parse and the `stringbool` off-path.
2. **Pure-compute tools** (no deps on each other, no external I/O): `toolkit_hash_value`, `toolkit_encode_value`, `toolkit_generate_id`. Crypto + Buffer + CSPRNG. Tests assert digests against known vectors, constant-time compare, round-trip encode/decode, and ID format/count.
3. **`toolkit_generate_qr`** — add the QR library, implement the three formats, test SVG well-formedness, PNG base64 decodes to a valid header, terminal string non-empty. Verify `version` reflects data density.
4. **`GeoService` + `toolkit_geolocate_ip`** — service with retry/backoff/cache, then the tool. Tests use a fake provider client; include a **sparse-payload case** (reserved IP, omitted ASN) asserting nullable fields stay null and `format()` doesn't fabricate.
5. **Private-range guard + `NetDiagService`** — the two-tier gate logic, unit-tested against `169.254.169.254`, `10.x`, `127.0.0.1`, `::1`, link-local, and public targets, under both `ALLOW_PRIVATE_NETWORK` states.
6. **`toolkit_check_network`** (Node-only) — the four modes over the guard. Field-test on the local box.
7. **`toolkit_check_system`** (Node-only) — the five facets over `os`/`process`, plus `vm_stat` for the memory headroom under Bun on macOS.
8. **Conditional registration in `index.ts`** — parse the full configuration and assemble the mutable `tools` array inside `setup()`, after framework `.env` loading and before registry construction: always-on five, then push the two gated tools per their flags. Configuration failures receive the startup banner. Test that flags-off yields five tools and flags-on yields seven, including `.env`-only Node startup.
9. **Polish** — README leading with ID-gen + QR, CHANGELOG, `server.json`/`manifest.json` env sync, `polish-docs-meta`, `security-pass`.

---

## Workflow Analysis

Most tools are single-call and self-contained — no cross-tool ID handoff exists because the server mints no durable handles. The chains that do occur are short and worth making explicit so a weaker model gets them right.

**1. Verify a download against a vendor checksum** (no cross-tool dependency, but a two-arm single tool):

| # | Call | Purpose |
|---|---|---|
| 1 | `toolkit_hash_value` `{ operation: 'compare', algorithm: 'sha256', value: <downloaded-bytes-or-hex>, expected: <vendor-digest> }` | Constant-time compare in one call — the agent does **not** call `generate` then eyeball-match; `compare` is the safe path. `expected` may be the vendor's digest as published: hex, base64, SRI, a `sha256:` digest, or the file's line from a `SHA256SUMS` file. |

The lesson the description must teach: use `operation: 'compare'` with `expected`, not `generate` + manual string equality (timing-unsafe, error-prone for the model). Sending `expected` without `operation` also compares, so the natural "check this against the checksum" call shape never silently degrades to a bare digest.

**2. Make a scannable QR for a generated identifier** (the one genuine cross-tool hop):

| # | Call | Purpose |
|---|---|---|
| 1 | `toolkit_generate_id` `{ type: 'uuid_v7', count: 1 }` | Mint the id. Output `ids[0]` is the value to encode. |
| 2 | `toolkit_generate_qr` `{ data: <ids[0]>, format: 'png_base64' }` | `data` comes from step 1's `ids[0]`. |

The `toolkit_generate_qr` description names this: "data is the content to encode (a link, a generated identifier such as toolkit_generate_id's ids[0], or any string)", and `toolkit_generate_id`'s points the other way ("pass ids[0] as data").

**3. Locate an IP and read who owns it** (single external call):

| # | Call | Purpose |
|---|---|---|
| 1 | `toolkit_geolocate_ip` `{ target: '8.8.8.8' }` | One lookup → country/city/lat-lon + `asn`/`org`, with `isp`, `asHolder`, and `asName` naming the network operator when `org` is a customer label. `target` also accepts a hostname (DNS-resolved first; `resolvedIp` echoes which IP was used). |

No `check_network` dependency — geolocation calls the provider, never the target, so it's SSRF-free and always-on.

**4. Local network reachability check** (gated, two-tier gate in play):

| # | Call | Purpose | Gate |
|---|---|---|---|
| 1 | `toolkit_check_network` `{ mode: 'connectivity', target: 'db.internal', port: 5432 }` | TCP reachability of an internal host. | Requires `TOOLKIT_ENABLE_NET_DIAGNOSTICS=true` (without it, the tool is absent from `tools/list` entirely — not an error, just not there) **and** — because `db.internal` resolves into RFC-1918 — `TOOLKIT_ALLOW_PRIVATE_NETWORK=true` (without this second gate, the registered tool rejects the private target with `private_target_blocked` + a recovery hint naming the flag). |

---

## Design Decisions

- **Fail-closed via conditional registration (the whole point of the rebuild).** Gated tools are *not registered* when their flag is off — invisible in `tools/list`, not present-but-erroring. An agent on the hosted deployment can't even see net-diag/system-info. This inverts the legacy server's everything-on default and is the direct answer to "disable env vars for the insecure ones." Mechanism: `index.ts` builds the `tools` array from `getServerConfig()` flags inside `createApp()` setup, after environment loading and before tool registration.
- **Two-tier network gate.** Enabling net-diag still blocks RFC-1918 / reserved / loopback / link-local by default; reaching internal hosts needs the *second* `TOOLKIT_ALLOW_PRIVATE_NETWORK` gate. Kills the `169.254.169.254` metadata-endpoint and internal-recon SSRF vectors even when diagnostics are intentionally on. The guard lives in one place (`NetDiagService`) so no mode can bypass it.
- **Public-IP detection folds into `check_network`** (`mode: 'public_ip'`), not its own tool — it leaks the host's egress IP, so it belongs behind the same net-diag gate rather than always-on.
- **Mode-enum consolidation over tool sprawl.** Operations that share a noun collapse into one tool with a mode/operation/what/type enum: `hash_value` (generate/compare), `encode_value` (encode/decode × encoding), `generate_qr` (format), `check_network` (4 modes), `check_system` (5 facets). Tightens the catalog and keeps the verb+noun unambiguous. `generate_id` keeps `type` as the discriminator for the same reason.
- **`generate_id` is `readOnlyHint: true` / `idempotentHint: false`.** The two hints answer different questions: read-only asks whether the tool modifies its environment (it does not — it draws entropy and returns it), idempotent asks whether repeat calls add no further effect (they do not repeat — fresh entropy is the feature). `idempotentHint: false` alone carries the don't-cache signal, so claiming a write to get it buckets a side-effect-free tool with genuinely mutating ones and degrades every caller's approval flow.
- **md5/sha1 stay, flagged.** Not a host-security risk (checksums here, not password crypto); dropping them breaks legit file-integrity checks against vendor-published MD5s, and HMAC-SHA1 still signs legacy webhooks (GitHub's `X-Hub-Signature: sha1=…`) and is not broken by SHA-1 collisions. Default to sha256; the description says md5/sha1 are for checksums and verifying existing HMAC-SHA1 signatures only, never passwords or new signatures. Keeping them avoids forcing the agent to a sandbox for a routine vendor-checksum match.
- **`compare` is constant-time.** `crypto.timingSafeEqual`, exposed as a first-class operation so the model never reaches for timing-unsafe string equality.
- **HMAC rides `hash_value` as an optional `secret`, not a separate tool.** A second tool would duplicate the algorithm set, the digest encodings, and the `expected` grammar and compare contract, which already fit webhook and HS256 signatures. The input is named `secret` because the framework redacts argument values by field name (in the opt-in failure-payload log among others) and covers `secret` but not `key`; registering `key` as sensitive would also redact every field ending in `key`. There is no `key` alias either, since that record logs arguments as the caller sent them, before an alias is resolved. An empty `secret` counts as absent, as an empty `expected` does for form clients; any other secret is used exactly as written.
- **`expected` and `outputEncoding` are never silently ignored.** `hash_value`'s `operation` and `encode_value`'s `outputEncoding` carry no schema default so the handler can tell omission from an explicit value; `expected` with an omitted operation compares, and an explicit field that contradicts another (`generate` + `expected`, `encode` + `outputEncoding`) is a typed error rather than a silent no-op.
- **`expected` is read by shape, scoped to the algorithm.** The trimmed value is read in a fixed order, first fit wins: SRI, when its first token is an entry (`sha256-`/`sha384-`/`sha512-`, any case); a refusal of any line break, since a pasted multi-line `SHA256SUMS` holds other files' digests and picking this file's line is the caller's call; a tagged checksum line (`SHA256 (<file>) = <digest>`, OpenSSL's `SHA2-256(<file>)= <digest>`, the file name running to the last `)` before the digest); an untagged one (`<hex>  <file>`); an `<algorithm>:` or `<algorithm>=` prefix; a bare digest. A bare digest of only hex digits is always read as hex, otherwise standard base64, otherwise base64url: a hex digest of another algorithm can have a valid base64 length (64 hex characters decode to 48 bytes, a sha384 digest), so trying base64 after a failed hex reading would answer `matches: false` where the real problem is the algorithm, and a string valid in both base64 alphabets decodes to the same bytes in either. An untagged line takes a hex digest only, so a run of words is not read as a short base64 digest, and its file name must hold something besides hex digits: hex split into whitespace-separated groups has the same shape, and reading its first group as the digest would report a length mismatch, or point at an algorithm whose compare can only fail, for what is one digest written in pieces. Such input is `expected_malformed`; the cost is the line for a file named only in hex digits, whose bare digest still reads. An SRI value may carry several space-separated entries, as npm `integrity` can: entries for other algorithms are skipped and it matches when any entry for `algorithm` does. A tag, prefix, or SRI value naming only other algorithms is `expected_algorithm_mismatch` rather than ignored, since it could only ever answer `matches: false`. A digest in a recognized form at the wrong length stays `expected_length_mismatch`, its hint naming the algorithm that length belongs to unless a tag or prefix already names one; only unrecognizable input is `expected_malformed`. Every pattern runs over uncapped caller text, so each one pairs adjacent quantifiers over disjoint character classes and runs in linear time.
- **Decode never substitutes bytes.** UTF-8 output uses a fatal, BOM-preserving decoder, so non-text bytes fail with `decode_not_utf8` (pointing at `outputEncoding` hex/base64) instead of becoming U+FFFD; decoding a `url` value to `hex` or `base64` fails `decode_failed` on an unpaired surrogate rather than writing out U+FFFD's bytes for it, while `utf8` output returns the value's literal characters as sent.
- **Same-millisecond uuid_v7/ulid steps are random.** Within one millisecond a batch advances its suffix by a fresh 32-bit draw plus one, not by one, so the batch stays strictly increasing while no id is derivable from its neighbour — RFC 9562 §6.2 advises against a +1 counter for unguessable ids. This departs from the ULID reference increment on purpose, since the tool's unpredictability claim covers both formats. Overflow is detected on the unmasked sum and falls back to advancing the timestamp and redrawing.
- **Terminal QR is plain half-blocks, drawn for a dark background.** No ANSI escapes, fenced in `content[]`; light modules (quiet zone included) are ink and dark modules are spaces, so the grid keeps correct polarity without setting a background color. `margin` sets its quiet zone like the other formats.
- **SVG honors `scale` as presentational size.** `width`/`height` are `(modules + 2 × margin) × scale`; the markup is still vector, so the PNG pixel budget does not apply.
- **Geolocation is the lone external dep among the always-on tools**, so the only one with `openWorldHint: true`, and the only tool with a resilience layer (retry/backoff/cache). The gated `toolkit_check_network` also declares `openWorldHint: true`: it probes caller-named hosts, and `public_ip` calls an external echo service. Default to a keyless-tier provider (ip-api class) for a zero-config hosted profile; provider/key are overridable for operators who want a richer source.
- **Hostname input on geo/network tools** is accepted and DNS-resolved server-side (`resolvedIp` echoed back) — agents routinely hold a hostname, not an IP, and forcing a separate resolve step is friction. The private-range guard runs **after** resolution so a hostname can't smuggle a request to an internal IP.
- **Network names stay separate instead of collapsing into `org`.** ip-api's `org` is often a customer or sub-allocation label, while `isp`, the AS holder, and `asname` name the operator. Any single precedence drops the other names, and which one is right depends on the question, so `org` keeps its precedence (ip-api `org`, then AS holder, then `isp`) and the three ride beside it. Reverse DNS is out: ip-api's `/batch` endpoint doesn't return it, so single and batch rows couldn't carry it consistently.
- **No resources, no prompts.** Nothing is a durable addressable entity; nothing is a recurring multi-step pattern. A tool-only client gets every tool; the published skill is the one resource listed, and `instructions` carries what a client that never reads it needs.
- **Supersedes, not migrates.** The legacy v1.0.1 codebase isn't ported — clean framework build. On ship, flip catalog status to active; the legacy repo gets the standard deprecation pointer.

---

## Error Contract

Typed contracts (`errors: [{ reason, code, when, recovery }]`) where a domain failure is worth the agent planning around. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and aren't enumerated.

| Tool | reason | code | when | recovery |
|---|---|---|---|---|
| `toolkit_hash_value` | `missing_expected` | `ValidationError` | operation is "compare" but no expected digest was supplied. | Provide expected (the digest to compare against) when operation is "compare". |
| `toolkit_hash_value` | `expected_without_compare` | `ValidationError` | operation is "generate" but an expected digest was also supplied, so it would be ignored. | Set operation to "compare" (or omit it) to check value against expected, or drop expected to generate a digest. |
| `toolkit_hash_value` | `expected_malformed` | `ValidationError` | expected is not a digest in any form the tool reads, spans several lines (a whole checksum file), or is an SRI value holding a token that is not an SRI entry. | Pass expected as one digest: hex, base64, or base64url, SRI entries such as sha512-&lt;base64&gt;, one line of a checksum file, or a prefixed digest such as sha256:&lt;hex&gt;. |
| `toolkit_hash_value` | `expected_length_mismatch` | `ValidationError` | expected is a recognized digest form but its length does not match the algorithm, so compare would always fail. | The expected digest length doesn't match the algorithm. Set algorithm to the one that length belongs to, or check the expected value. |
| `toolkit_hash_value` | `expected_algorithm_mismatch` | `ValidationError` | expected names an algorithm other than the chosen one, in a checksum-line tag, an &lt;algorithm&gt;: or &lt;algorithm&gt;= prefix, or SRI entries none of which names the chosen algorithm. | Set algorithm to the one expected names, or pass a digest made with the chosen algorithm. |
| `toolkit_hash_value` | `sri_unsupported_algorithm` | `ValidationError` | digestEncoding is "sri" and algorithm is md5 or sha1, which SRI does not define. | Use algorithm sha256, sha384, or sha512 for an SRI digest, or set digestEncoding to base64 or hex. |
| `toolkit_hash_value` | `invalid_input_encoding` | `ValidationError` | value is not valid for the declared inputEncoding (e.g. non-hex characters with inputEncoding "hex"). | Input is not valid for the declared inputEncoding. Verify the encoding matches the byte representation. |
| `toolkit_hash_value` | `invalid_secret_encoding` | `ValidationError` | secret is not valid for the declared secretEncoding (e.g. non-hex characters with secretEncoding "hex"). | Set secretEncoding to how secret is written: utf8 for a plain-text webhook secret, base64url for a JWK k value, or hex or base64 for raw key bytes. |
| `toolkit_hash_value` | `sri_with_secret` | `ValidationError` | digestEncoding is "sri" on operation "generate" and a secret was supplied; SRI carries plain digests, not HMACs. | Set digestEncoding to hex, base64, or base64url for an HMAC, or drop secret to generate a plain SRI digest. |
| `toolkit_generate_qr` | `data_too_large` | `ValidationError` | data exceeds the QR capacity for the chosen errorCorrection level and encoding mode. | Shorten data, or lower errorCorrection (H→Q→M→L) to raise capacity, then retry. |
| `toolkit_generate_qr` | `raster_too_large` | `ValidationError` | format is png_base64 and (modules + 2 × margin) × scale exceeds the pixel budget. | Lower scale (and margin if needed) so the rendered image stays within 2048 px per side, or request format svg, which has no raster budget. |
| `toolkit_encode_value` | `decode_failed` | `ValidationError` | operation is "decode" but value is malformed for the chosen encoding. | Value isn't valid for the chosen encoding. Verify the encoding matches the input, or switch operation to 'encode'. |
| `toolkit_encode_value` | `decode_not_utf8` | `ValidationError` | operation is "decode", outputEncoding is utf8 (or omitted), and the decoded bytes are not valid UTF-8 text. | The decoded bytes are binary, not UTF-8 text. Retry with outputEncoding 'hex' or 'base64' to receive the raw bytes losslessly. |
| `toolkit_encode_value` | `output_encoding_not_applicable` | `ValidationError` | operation is "encode" and outputEncoding was supplied; it selects how decoded bytes are returned. | outputEncoding applies only to decode. Drop outputEncoding to encode text, or set operation to 'decode'. |
| `toolkit_geolocate_ip` | `unresolvable_host` | `ValidationError` | A hostname target failed DNS resolution. | Hostname didn't resolve. Verify it, or pass an IP address directly. |
| `toolkit_geolocate_ip` | `private_target` | `ValidationError` | The target resolves to a private/reserved IP, or to a public-format IP the provider reports as unlocatable (reserved, unrouted, or bogon); neither has public geolocation. | This address is private, reserved, unrouted, or bogon, so it has no public geolocation. Pass a routable public IP address, or a hostname that resolves to one. |
| `toolkit_geolocate_ip` | `rate_limited` | `RateLimited` | The endpoint request quota or provider cooldown is exhausted. | Wait the reported number of seconds before retrying, or reuse a cached result. |
| `toolkit_check_network` | `private_target_blocked` | `ValidationError` | The target, or every address a hostname target resolves to, is private/reserved/loopback/link-local and TOOLKIT_ALLOW_PRIVATE_NETWORK is off. | This target is a private/reserved address. Set TOOLKIT_ALLOW_PRIVATE_NETWORK=true to permit local-network diagnostics. |
| `toolkit_check_network` | `unreachable` | `ServiceUnavailable` | No diagnosis ran: a hostname target could not be resolved, which fails every mode, connectivity included; or the ping/traceroute binary gave no result for any address tried, because it is missing or could not start, was stopped at its time limit, or exited with an error status and no readable result. | If the hostname could not be resolved, check its spelling or pass its IP address instead; connectivity resolves it the same way. If ping or traceroute gave no result, run mode connectivity with the port of a service the host runs (e.g. 443), which needs no binary. |
| `toolkit_check_network` | `family_mismatch` | `ValidationError` | family is set and the target has no address of that family: an IP address of the other family, or a hostname without such a record. | Omit family to probe whichever family the target has, or set family to match an address the target resolves to. |
| `toolkit_check_network` | `missing_target` | `ValidationError` | mode is ping, traceroute, or connectivity and no target was supplied. | Pass target as an IPv4/IPv6 address or hostname, or use mode public_ip, which takes no target. |
| `toolkit_check_network` | `missing_port` | `ValidationError` | mode is connectivity and no port was supplied. | Pass port as a separate number (e.g. 443) — connectivity needs one to connect to. |
| `toolkit_check_system` | `memory_stats_unavailable` | `ServiceUnavailable` | what is memory, the server runs under Bun on macOS, and the host page statistics could not be read because the statistics command failed to start, did not finish in time, exited with a non-zero status, was terminated by a signal, or printed no page counts. | Retry once; if it fails again, treat memory headroom as unknown on this host rather than estimating it, and use the other facets, which do not read these statistics. |

A host that is simply down is not an error: ping and connectivity report it as `reachable: false`, a valid result the agent acts on. The `unreachable` reason covers only the cases where no diagnosis could run at all. A hostname that does not resolve throws it before any probe, in every mode: `connectivity` resolves through the same guard, so it is no fallback for a resolution failure. For ping, the dividing line is the packet-loss summary: a run that printed one is a result whatever its exit status, and `reachable` is whether any reply came back (Linux iputils exits 1 on partial loss too), while a binary that never spawned (the error names the binary and its errno, e.g. `ENOENT`) or exited without a summary it could read (the error says the output could not be interpreted and carries its stderr) throws `unreachable`. Traceroute counts only a clean exit as a result. For both, a run killed at its spawn timeout with no result (the error says it did not finish within that many milliseconds) ends the probe there, without trying the hostname's remaining addresses, and throws `unreachable`.

`toolkit_generate_id` has no domain-specific failure contract — bad input is rejected at the schema as `InvalidParams`, and there's no partial-success or multi-step finalize. `toolkit_check_system`'s one reason covers the only subprocess it runs: under Bun on macOS, `memory` runs `vm_stat` (bounded by a 5-second timeout and the caller's cancellation), and a run that fails or prints no page counts fails the call rather than reporting free pages as the headroom. `generate_qr`'s two reasons both cover limits the schema cannot express on its own: `data` is capped at `z.string().max(2953)`, a character count that only bounds the real limit — capacity is 2953 UTF-8 bytes at version 40, level L, lower at M/Q/H — and the rendered pixel count is a product of three inputs, so each is checked in the handler and surfaced as a typed reason rather than a raw library failure. `hash_value`'s `expected_without_compare` and `encode_value`'s `output_encoding_not_applicable` reject a contradiction between two supplied fields rather than ignoring one of them, which is also why neither tool gives the discriminating field (`operation`, `outputEncoding`) a schema default: the handler has to see whether it was sent.

---

## Output Design Notes

- **`format()` content-complete on every tool.** Hash → the digest (or match verdict) in a code span; QR `terminal` → the renderable block inside a code fence (so a Markdown client keeps the spaces that are its dark modules), `svg` → the markup, `png_base64` → a note plus byte length (not the full blob inline for PNG); geo → a labeled summary (country, city, coords, ASN/org, ISP and AS holder/name). Every `output` field the model needs appears in the rendered text — `format-parity` enforces it.
- **Batch ID disclosure.** `toolkit_generate_id` with a large `count` is bounded by `z.number().int().min(1).max(1000)` — not a silently truncated list. `count` is small enough that no truncation/`ctx.enrich.truncated` is needed; the array is always complete.
- **Geolocation preserves uncertainty.** Absent upstream fields stay omitted in `structuredContent`; `format()` renders them as unknown. Tests include sparse payloads with omitted metadata.
- **Provider strings render as literal text.** Location names, `asn`, `org`, `isp`, `asHolder`, and `asName` are third-party text, and the network names come from registry records the address holder controls, so `format()` passes each through `escapeMarkdownInline` (`@cyanheads/mcp-ts-core/utils`): every value reads back exactly as `structuredContent` carries it, never as a link, emphasis, or HTML. The authored labels and `_unknown_` stay live Markdown, and the 256-character field cap applies before `format()` runs.
- **PNG bytes don't bloat context.** `png_base64` returns the base64 string in `content` (the artifact the model can't emit, so it must be returned) but `format()` summarizes ("QR code (format png_base64, version {version}, mimeType image/png, {byteLength} bytes). The PNG is attached as an image block.") rather than dumping the base64 into the markdown trailer twice.
- **`source` provenance on geo.** Always report which provider answered, so the agent (and human) can weigh the result.

---

## Known Limitations

- **Geolocation accuracy is provider-bounded.** Keyless ip-api-class data is coarse (city-level at best, often just country/region). Independent single/batch request budgets reject excess work as `rate_limited`; provider 429 closes only its endpoint's cooldown. Cache hits remain available and quota-free. Other provider failures are sanitized as `ServiceUnavailable`.
- **Geolocation is best-effort, not authoritative.** VPNs, proxies, mobile carrier-grade NAT, and anycast all defeat IP→location. Treat results as a hint.
- **Network diagnostics depend on host environment.** ICMP ping may be blocked by the OS or unavailable in a container without `NET_RAW`; traceroute hop visibility varies; `connectivity` (raw TCP) is the most portable mode. The published Docker image ships neither `ping` nor `traceroute`, so those modes throw `unreachable` there. macOS `ping6` has no deadline flag: it sends one echo a second and then waits a fixed 10 s for the last reply, so an IPv6 ping that gets no answer takes about `count` + 10 seconds, whatever `timeoutMs` says. Ping reads its packet-loss summary in English only; a localized Windows prints it in its own language, so a run with no replies there throws `unreachable` (its output could not be interpreted) rather than reporting the host down, and a responding run reports `reachable: true` without the packet counts or RTT. Under Bun on macOS a TCP connect with no route fails `ECONNREFUSED` (Node: `EHOSTUNREACH`), which the server cannot tell from a real refusal, so when every address of a `connectivity` probe fails that way — an IPv6-only target, or `family: 6`, on a host with no IPv6 route — the reported outcome is `refused`. A first address that drops packets silently spends the whole `connectivity` budget and is reported as `timeout` with its `resolvedIp`; `family` pins the other family. `public_ip` reports IPv4 egress only. The hosted profile disables all of this anyway.
- **Container memory depends on the runtime.** Under a cgroup limit, `os.totalmem()`/`os.freemem()` still read the host. Node's `process.availableMemory()` respects the limit but Bun's does not — Bun's is `os.freemem()`, a host figure — so `availableBytes` is clamped to the limit minus the cgroup's current usage (`memory.current`, or `memory.usage_in_bytes` on cgroup v1). That usage includes reclaimable page cache, so under a limit the figure is conservative. With no limit the two runtimes report the same headroom: Bun's `os.freemem()` is already `MemAvailable` on Linux and the available-physical figure on Windows, as Node's `availableMemory()` is, and on macOS, where it is free pages alone, the tool computes Node's figure itself — (free + inactive + purgeable pages) × the page size, read from `vm_stat` on each `memory` call. The usage file is read at `/sys/fs/cgroup`, which inside a container is the container's own cgroup; a process limited by its own cgroup on a bare cgroup-v1 host would read the host-wide figure there and report zero headroom.
- **System info reflects the server host, not the client** — only meaningful on a local/self-hosted deployment, which is why it's gated off by default.
- **md5/sha1 are cryptographically broken** for signatures/passwords. Retained strictly for checksum/compatibility; the description says so.

---

## v1 Scope vs. Deferred

**v1 ships:**

- All seven tools: five always-on (`toolkit_hash_value`, `toolkit_generate_id`, `toolkit_generate_qr`, `toolkit_encode_value`, `toolkit_geolocate_ip`) + two gated (`toolkit_check_network`, `toolkit_check_system`).
- Fail-closed conditional registration + the two-tier network gate.
- `GeoService` with retry/backoff/cache against a keyless default provider; provider/key overridable.
- One entry point for Bun and Node, over stdio and Streamable HTTP.
- Full DX: Zod-validated format constraints, typed error contracts, content-complete `format()`, descriptions leading with the criterion-clearing tools.

**Deferred:**

- **Additional hash algorithms** (sha3, blake2/blake3) — add if a real consumer needs them; sha256/512 + md5/sha1-compat cover the field today.
- **Additional ID formats** (nanoid, KSUID, snowflake) — UUIDv4/v7 + ULID cover the common cases.
- **QR decode / read-from-image** — generation is the asymmetric win; decode is rarely asked and the model can often OCR.
- **Richer/keyed geo providers** (MaxMind, ipinfo) as first-class options beyond the override knob.
- **Resources / prompts** — none earn their place in v1; revisit only if a durable entity or recurring workflow emerges.
- **DNS lookup / whois as standalone tools** — out of scope; whois-mcp-server owns that.
