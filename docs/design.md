# toolkit-mcp-server — Design

A from-scratch rebuild of the legacy v1.0.1 `toolkit-mcp-server` on mcp-ts-core: a small grab-bag of system and developer utilities, redesigned **fail-closed**. The always-safe tools register everywhere; the two groups that are unsafe on a shared host (network diagnostics, system monitoring) are **off by default behind enable-gates**, so the hosted deployment exposes only what carries no SSRF or info-disclosure risk.

This doc formalizes `docs/idea.md` into a buildable spec. The tool names are fixed — seven tools, five always-on and two gated.

---

## MCP Surface

### Tools

| Tool | Summary | readOnlyHint | openWorldHint | Key inputs | Output shape |
|---|---|---|---|---|---|
| `toolkit_hash_value` | Generate a digest or constant-time-compare a value against an expected digest. | `true` | `false` | `operation` (`generate`\|`compare` — omitted resolves to `compare` when `expected` is sent, else `generate`), `value`, `algorithm` (`sha256`\|`sha384`\|`sha512`\|`sha1`\|`md5`), `digestEncoding` (`hex`\|`base64`\|`sri` — default `hex`, generate only), `expected` (hex, base64, or one or more SRI entries; compare only), `inputEncoding` (`utf8`\|`hex`\|`base64` — default `utf8`) | `{ algorithm, operation, digest?, matches?, lengthInBytes? }` |
| `toolkit_generate_id` | Mint cryptographically-random identifiers (UUIDv4/UUIDv7/ULID), single or batch. | `true`¹ | `false` | `type` (`uuid_v4`\|`uuid_v7`\|`ulid`), `count` | `{ type, ids[], count }` |
| `toolkit_generate_qr` | Encode text/URL into a QR code as SVG markup, base64 PNG bytes, or a terminal-renderable string. | `true` | `false` | `data`, `format` (`svg`\|`png_base64`\|`terminal`), `errorCorrection`, `margin`, `scale` | `{ format, content, mimeType?, byteLength?, version }` |
| `toolkit_encode_value` | Encode or decode a value across base64 / base64url / hex / URL. | `true` | `false` | `operation` (`encode`\|`decode`), `encoding`, `value`, `outputEncoding` (`utf8`\|`hex`\|`base64` — decode only; omitted means `utf8`) | `{ encoding, operation, outputEncoding?, result }` |
| `toolkit_geolocate_ip` | Resolve a public IP (or hostname) to geographic and network metadata via an external geo API. | `true` | `true` | `target` (IPv4/IPv6/hostname) | `{ target, resolvedIp, country, countryCode, region, city, latitude, longitude, asn, org, timezone, proxy, hosting, mobile, source }` |
| `toolkit_check_network` | **Gated.** Network diagnostics — ping, traceroute, TCP connectivity, or host egress-IP detection. | `true` | `true` | `mode` (`ping`\|`traceroute`\|`connectivity`\|`public_ip`), `target` (required for all modes except `public_ip`), `port` (connectivity only), `count`, `timeoutMs` | `{ mode, target?, reachable?, outcome?, rttMs?, sent?, received?, packetLossPercent?, hops?, publicIp? }` |
| `toolkit_check_system` | **Gated.** Host system facts — OS, CPU, memory, load average, or network interfaces. | `true` | `false` | `what` (`os`\|`cpu`\|`memory`\|`load`\|`interfaces`) | `{ what, ...facetFields }` |

¹ `toolkit_generate_id` is `readOnlyHint: true` — minting draws from the CSPRNG and returns it, modifying nothing — paired with `idempotentHint: false`, since each call produces fresh non-reproducible entropy (the whole point) and must not be cached or deduplicated. It performs no external I/O, so `openWorldHint: false`.

**Gated tools register conditionally.** `toolkit_check_network` registers only when `TOOLKIT_ENABLE_NET_DIAGNOSTICS=true`; `toolkit_check_system` only when `TOOLKIT_ENABLE_SYSTEM_INFO=true`. When a flag is off the tool is **absent from `tools/list`** — invisible, not present-and-erroring (see Design Decisions: fail-closed).

### Resources

None in v1. Every capability is an action (compute / mint / probe), not a stable addressable entity — there is no `toolkit://thing/{id}` that an agent would inject as context. A geolocation result is a live lookup, not a durable record. Resources add nothing a tool-only client can't already reach.

### Prompts

None in v1. The tools are self-explanatory single actions with no recurring multi-step interaction pattern worth templating.

---

## Overview

`toolkit-mcp-server` gives an agent (and its human) a handful of quick utilities without leaving the conversation: hash a value, mint IDs, make a QR code, locate an IP. It wraps no single product API — it is mostly an **internal-capability** server (Node crypto, `os`/`process`, pure string transforms) with **one external dependency** (an IP-geolocation API).

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
- Hashing supports sha256 (default), sha384, sha512, sha1, md5. `compare` is **constant-time** (`crypto.timingSafeEqual`). md5/sha1 are exposed for checksum/compatibility only and the description must say "not for security". `inputEncoding` (`utf8` default | `hex` | `base64`) controls how `value` is interpreted before hashing — necessary so the agent can hash raw binary data supplied as hex or base64 without round-tripping through a decode step. `digestEncoding` (`hex` default | `base64` | `sri`) sets the generated digest's form; `expected` is accepted as hex, base64, or SRI and recognized by shape at the algorithm's digest length, since the most common published digests (npm lockfile `integrity`, Subresource Integrity, `Content-MD5`, `x-amz-checksum-sha256`) are base64 or SRI, not hex.
- ID generation uses the platform CSPRNG for all three types and supports batch via `count` (Zod `.max(1000)` — large enough for any realistic batch, small enough to keep the response inline without truncation).
- QR generation emits SVG (text, sized `(modules + 2 × margin) × scale` px), base64-encoded PNG, or a terminal string of plain Unicode half-blocks, with configurable error-correction level, quiet-zone margin, and module scale.
- Encoding covers base64, base64url, hex, URL — both directions. Decode is byte-preserving: `outputEncoding` returns the recovered bytes as UTF-8 text (default, fatal on invalid UTF-8), hex, or base64, so binary payloads and digests transcode without loss. Whitespace in hex/base64/base64url input is ignored.
- Geolocation accepts an IP **or** a hostname, resolves to country/region/city, lat/lon, ASN/org, timezone, and reports its `source` provider. It is cached and rate-limited.
- `toolkit_check_network` supports `ping`, `traceroute`, `connectivity` (TCP reachability — host via `target`, port via separate `port` param, not inline `host:port` syntax), and `public_ip` (host egress IP — `target` is absent/ignored for this mode). Private/reserved/loopback/link-local targets are **rejected** unless `TOOLKIT_ALLOW_PRIVATE_NETWORK=true`. `ping` reports `sent`/`received`/`packetLossPercent` from the binary's summary line; `connectivity` reports an `outcome` (`open` | `refused` | `timeout` | `unreachable`) and, when open, the connect time as `rttMs`. On macOS/BSD an IPv6 address runs `ping6`/`traceroute6`, since their `ping`/`traceroute` reject IPv6; Linux and Windows use one binary for both families.
- `toolkit_check_system` reports host OS, CPU, memory, load, or interfaces. Memory carries `availableBytes` (headroom for new allocations) and, inside a container, `limitBytes`, alongside the raw OS `totalBytes`/`freeBytes`/`usedBytes`.

**Non-functional**

- **Fail-closed.** Enable-flags default `false`. The hosted profile sets none → only the five always-on tools exist.
- **Two-tier network gate.** Even with net-diag enabled, private/reserved destinations need the second explicit `TOOLKIT_ALLOW_PRIVATE_NETWORK` gate. This blocks the cloud-metadata endpoint (`169.254.169.254`) and internal-`10.x`/`172.16/12`/`192.168` recon vectors.
- **Range coverage is a denylist for IPv4 and an allowlist for IPv6.** IPv4 enumerates the IANA special-use blocks; IPv6 admits only `2000::/3` minus the special-use blocks carved out of it (6to4, Teredo, ORCHID/ORCHIDv2, documentation, benchmarking), so unallocated and future-assigned space classifies as reserved instead of slipping through a forgotten denylist entry. IPv4-mapped addresses are classified by their embedded IPv4 in either the dotted (`::ffff:127.0.0.1`) or hex (`::ffff:7f00:1`) spelling.
- **Runtime split (mirror whois).** `toolkit_check_network` (raw sockets / ICMP) and `toolkit_check_system` (`os`/`process`) are **Node-only**. The Cloudflare Workers build carries only hash + id + encode + qr + geolocate (all HTTPS / pure-compute). Document so the Workers path isn't expected to diagnose networks.
- **Resilience scoped to the one external dep.** Geolocation gets retry/backoff/cache; everything else is local and synchronous, no resilience layer.
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
  digest?: string;          // generate: lowercase hex, base64, or `<algorithm>-<base64>`
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
  outputEncoding?: 'utf8' | 'hex' | 'base64';  // decode only: how `result` renders the bytes
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
  reachable?: boolean;       // ping + connectivity: false is a valid result, not an error
  outcome?: 'open' | 'refused' | 'timeout' | 'unreachable';  // connectivity
  rttMs?: number;            // ping: average echo time; connectivity: connect time, only when open
  sent?: number;             // ping, reachable or not: echo requests transmitted
  received?: number;         // ping: echo replies received
  packetLossPercent?: number; // ping: 0–100, one decimal, computed from sent/received
  hops?: Array<{ hop: number; address: string; rttMs?: number }>;  // traceroute
  publicIp?: string;         // public_ip: the host's egress IP as seen by the external probe
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
  org?: string;             // e.g. "Google LLC"
  timezone?: string;        // IANA, e.g. "America/Los_Angeles"
  source: string;           // provider that answered, e.g. "ip-api"
};
```

**Network identifiers.** Targets are caller-supplied IPv4/IPv6/hostnames — validated by Zod via `z.union([z.ipv4(), z.ipv6(), z.string().regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/)])` (covers both raw IPs and valid hostnames; rejects bare single-label strings that could alias metadata endpoints). Never minted here. The agent obtains them from its own context (a log line, a URL, a prior tool); the server adds no resolver step beyond `geolocate`/`check_network` doing their own DNS. The private-range guard runs **after** DNS resolution so a hostname can't smuggle a private IP past the Zod validator.

---

## Services

The surface is overwhelmingly internal capability backed by Node builtins — only one true service.

| Service | Wraps | Key methods | Used by |
|---|---|---|---|
| `GeoService` | One external IP-geolocation API (keyless ip-api class by default; provider/key overridable) | `lookup(target): Promise<GeoResult>` — DNS-resolve hostname → IP, call provider with retry/backoff, normalize sparse upstream, in-memory TTL cache keyed by resolved IP | `toolkit_geolocate_ip` |

Everything else needs **no service** — pure functions over Node builtins, invoked directly from the handler:

- **Hashing / compare** → `node:crypto` (`createHash`, `timingSafeEqual`). No shared state.
- **ID generation** → `node:crypto.randomUUID()` (v4), a UUIDv7 generator, and a ULID generator (both small, deterministic given the CSPRNG seed). One tiny dependency or inline implementation; no service.
- **QR generation** → a QR-encode library (e.g. `qrcode`) producing SVG string / PNG buffer; `terminal` rendered from the module matrix. Pure compute, no service.
- **Encoding** → `Buffer` (base64/base64url/hex) and `encodeURIComponent`/`decodeURIComponent` (URL). No service.
- **Network diagnostics** → `node:net`/`node:dns` plus a ping/traceroute primitive. A thin `NetDiagService` is justified **only** to centralize the private-range guard (the two-tier gate must be enforced in one place, not duplicated per mode); it holds no upstream and no resilience layer. Note: this is a **separate gate from the config-flag guard** — the config flag (`TOOLKIT_ENABLE_NET_DIAGNOSTICS`) controls *registration* at startup; the private-range guard fires at *request time* inside the registered handler. Do not conflate them.
- **System info** → `node:os` / `node:process`. Direct, no service.

**GeoService resilience** (the only external dep):

| Concern | Decision |
|---|---|
| Retry boundary | Service method wraps DNS-resolve + fetch + parse via `withRetry` from `/utils`. |
| Backoff | 1–2 s base between retries of a failed lookup. |
| Rate limit | A per-minute budget (`TOOLKIT_GEO_RATE_LIMIT_PER_MIN`, default 45 to match the keyless ip-api tier); a lookup past it is rejected with a retryable rate-limit error rather than delayed. |
| HTTP check | `fetchWithTimeout` → non-OK becomes `ServiceUnavailable`. |
| Parse classification | Detect provider error envelopes (`status: "fail"`) and throw the right code, not `SerializationError`. |
| Cache | In-memory TTL (default ~1 h) keyed by resolved IP — geolocation is stable, this absorbs repeat lookups and protects the rate budget. |

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
7. **`toolkit_check_system`** (Node-only) — the five facets over `os`/`process`.
8. **Conditional registration in `index.ts`** — assemble the `tools` array from `getServerConfig()`: always-on five, then push the two gated tools per their flags. This is the fail-closed mechanism; test that flags-off yields a five-tool catalog and flags-on yields seven.
9. **Workers build guard** — ensure the Node-only tools are excluded from / inert on the Workers entry (they can't import raw sockets there); document the reduced surface.
10. **Polish** — README leading with ID-gen + QR, CHANGELOG, `server.json`/`manifest.json` env sync, `polish-docs-meta`, `security-pass`.

---

## Workflow Analysis

Most tools are single-call and self-contained — no cross-tool ID handoff exists because the server mints no durable handles. The chains that do occur are short and worth making explicit so a weaker model gets them right.

**1. Verify a download against a vendor checksum** (no cross-tool dependency, but a two-arm single tool):

| # | Call | Purpose |
|---|---|---|
| 1 | `toolkit_hash_value` `{ operation: 'compare', algorithm: 'sha256', value: <downloaded-bytes-or-hex>, expected: <vendor-digest> }` | Constant-time compare in one call — the agent does **not** call `generate` then eyeball-match; `compare` is the safe path. `expected` may be the vendor's hex, base64, or SRI string as published. |

The lesson the description must teach: use `operation: 'compare'` with `expected`, not `generate` + manual string equality (timing-unsafe, error-prone for the model). Sending `expected` without `operation` also compares, so the natural "check this against the checksum" call shape never silently degrades to a bare digest.

**2. Make a scannable QR for a generated identifier** (the one genuine cross-tool hop):

| # | Call | Purpose |
|---|---|---|
| 1 | `toolkit_generate_id` `{ type: 'uuid_v7', count: 1 }` | Mint the id. Output `ids[0]` is the value to encode. |
| 2 | `toolkit_generate_qr` `{ data: <ids[0]>, format: 'png_base64' }` | `data` comes from step 1's `ids[0]`. |

`toolkit_generate_qr.data`'s description names this: "the text/URL to encode — e.g. a value from `toolkit_generate_id`, a link, or any string."

**3. Locate an IP and read who owns it** (single external call):

| # | Call | Purpose |
|---|---|---|
| 1 | `toolkit_geolocate_ip` `{ target: '203.0.113.7' }` | One lookup → country/city/lat-lon + `asn`/`org`. `target` also accepts a hostname (DNS-resolved first; `resolvedIp` echoes which IP was used). |

No `check_network` dependency — geolocation calls the provider, never the target, so it's SSRF-free and always-on.

**4. Local network reachability check** (gated, two-tier gate in play):

| # | Call | Purpose | Gate |
|---|---|---|---|
| 1 | `toolkit_check_network` `{ mode: 'connectivity', target: 'db.internal', port: 5432 }` | TCP reachability of an internal host. | Requires `TOOLKIT_ENABLE_NET_DIAGNOSTICS=true` (without it, the tool is absent from `tools/list` entirely — not an error, just not there) **and** — because `db.internal` resolves into RFC-1918 — `TOOLKIT_ALLOW_PRIVATE_NETWORK=true` (without this second gate, the registered tool rejects the private target with `private_target_blocked` + a recovery hint naming the flag). |

---

## Design Decisions

- **Fail-closed via conditional registration (the whole point of the rebuild).** Gated tools are *not registered* when their flag is off — invisible in `tools/list`, not present-but-erroring. An agent on the hosted deployment can't even see net-diag/system-info. This inverts the legacy server's everything-on default and is the direct answer to "disable env vars for the insecure ones." Mechanism: `index.ts` builds the `tools` array from `getServerConfig()` flags before `createApp()`.
- **Two-tier network gate.** Enabling net-diag still blocks RFC-1918 / reserved / loopback / link-local by default; reaching internal hosts needs the *second* `TOOLKIT_ALLOW_PRIVATE_NETWORK` gate. Kills the `169.254.169.254` metadata-endpoint and internal-recon SSRF vectors even when diagnostics are intentionally on. The guard lives in one place (`NetDiagService`) so no mode can bypass it.
- **Public-IP detection folds into `check_network`** (`mode: 'public_ip'`), not its own tool — it leaks the host's egress IP, so it belongs behind the same net-diag gate rather than always-on.
- **Mode-enum consolidation over tool sprawl.** Operations that share a noun collapse into one tool with a mode/operation/what/type enum: `hash_value` (generate/compare), `encode_value` (encode/decode × encoding), `generate_qr` (format), `check_network` (4 modes), `check_system` (5 facets). Tightens the catalog and keeps the verb+noun unambiguous. `generate_id` keeps `type` as the discriminator for the same reason.
- **`generate_id` is `readOnlyHint: true` / `idempotentHint: false`.** The two hints answer different questions: read-only asks whether the tool modifies its environment (it does not — it draws entropy and returns it), idempotent asks whether repeat calls add no further effect (they do not repeat — fresh entropy is the feature). `idempotentHint: false` alone carries the don't-cache signal, so claiming a write to get it buckets a side-effect-free tool with genuinely mutating ones and degrades every caller's approval flow.
- **md5/sha1 stay, flagged.** Not a host-security risk (checksums here, not password/signature crypto); dropping them breaks legit file-integrity checks against vendor-published MD5s. Default to sha256; the description says "checksum/compat only — not for security." Keeping them avoids forcing the agent to a sandbox for a routine vendor-checksum match.
- **`compare` is constant-time.** `crypto.timingSafeEqual`, exposed as a first-class operation so the model never reaches for timing-unsafe string equality.
- **`expected` and `outputEncoding` are never silently ignored.** `hash_value`'s `operation` and `encode_value`'s `outputEncoding` carry no schema default so the handler can tell omission from an explicit value; `expected` with an omitted operation compares, and an explicit field that contradicts another (`generate` + `expected`, `encode` + `outputEncoding`) is a typed error rather than a silent no-op.
- **`expected` is read by shape, scoped to the algorithm.** A string of only hex digits is always read as hex, anything else in the base64 alphabet as base64: a hex digest of another algorithm can have a valid base64 length (64 hex characters decode to 48 bytes, a sha384 digest), so trying base64 after a failed hex reading would answer `matches: false` where the real problem is the algorithm. SRI is recognized by its `sha256-`/`sha384-`/`sha512-` prefix, and a value may carry several space-separated entries, as npm `integrity` can: entries for other algorithms are skipped, it matches when any entry for `algorithm` does, and no entry for `algorithm` is `expected_algorithm_mismatch`. A string in a digest alphabet at the wrong length stays `expected_length_mismatch`, its hint naming the algorithm that length belongs to; only unrecognizable input is `expected_malformed`.
- **Decode never substitutes bytes.** UTF-8 output uses a fatal, BOM-preserving decoder, so non-text bytes fail with `decode_not_utf8` (pointing at `outputEncoding` hex/base64) instead of becoming U+FFFD; decoding a `url` value to `hex` or `base64` fails `decode_failed` on an unpaired surrogate rather than writing out U+FFFD's bytes for it, while `utf8` output returns the value's literal characters as sent.
- **Same-millisecond uuid_v7/ulid steps are random.** Within one millisecond a batch advances its suffix by a fresh 32-bit draw plus one, not by one, so the batch stays strictly increasing while no id is derivable from its neighbour — RFC 9562 §6.2 advises against a +1 counter for unguessable ids. This departs from the ULID reference increment on purpose, since the tool's unpredictability claim covers both formats. Overflow is detected on the unmasked sum and falls back to advancing the timestamp and redrawing.
- **Terminal QR is plain half-blocks, drawn for a dark background.** No ANSI escapes, fenced in `content[]`; light modules (quiet zone included) are ink and dark modules are spaces, so the grid keeps correct polarity without setting a background color. `margin` sets its quiet zone like the other formats.
- **SVG honors `scale` as presentational size.** `width`/`height` are `(modules + 2 × margin) × scale`; the markup is still vector, so the PNG pixel budget does not apply.
- **Geolocation is the lone external dep**, so the only tool with a resilience layer (retry/backoff/cache) and `openWorldHint: true`. Default to a keyless-tier provider (ip-api class) for a zero-config hosted profile; provider/key are overridable for operators who want a richer source.
- **Hostname input on geo/network tools** is accepted and DNS-resolved server-side (`resolvedIp` echoed back) — agents routinely hold a hostname, not an IP, and forcing a separate resolve step is friction. The private-range guard runs **after** resolution so a hostname can't smuggle a request to an internal IP.
- **No resources, no prompts.** Nothing is a durable addressable entity; nothing is a recurring multi-step pattern. A tool-only client gets the full server.
- **Runtime split mirrors whois-mcp-server.** Raw-socket and `os`/`process` tools are Node-only; the Workers build ships hash + id + encode + qr + geolocate. Documented so the hosted-on-Workers path isn't expected to diagnose networks.
- **Supersedes, not migrates.** The legacy v1.0.1 codebase isn't ported — clean framework build. On ship, flip catalog status to active; the legacy repo gets the standard deprecation pointer.

---

## Error Contract

Typed contracts (`errors: [{ reason, code, when, recovery }]`) where a domain failure is worth the agent planning around. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and aren't enumerated.

| Tool | reason | code | when | recovery |
|---|---|---|---|---|
| `toolkit_hash_value` | `missing_expected` | `ValidationError` | operation is "compare" but no expected digest was supplied. | Provide expected (the digest to compare against) when operation is "compare". |
| `toolkit_hash_value` | `expected_without_compare` | `ValidationError` | operation is "generate" but an expected digest was also supplied, so it would be ignored. | Set operation to "compare" (or omit it) to check value against expected, or drop expected to generate a digest. |
| `toolkit_hash_value` | `expected_malformed` | `ValidationError` | expected is not a hex, standard base64, or sha256/sha384/sha512 SRI digest, or an SRI value holds a token that is not an SRI entry. | Pass expected as a hex digest, a standard base64 digest, or SRI entries such as sha512-&lt;base64&gt;, space-separated when there are several. |
| `toolkit_hash_value` | `expected_length_mismatch` | `ValidationError` | expected is a recognized digest form but its length does not match the algorithm, so compare would always fail. | The expected digest length doesn't match the algorithm. Set algorithm to the one that length belongs to, or check the expected value. |
| `toolkit_hash_value` | `expected_algorithm_mismatch` | `ValidationError` | expected is SRI and none of its entries names the chosen algorithm. | Set algorithm to one named in the SRI prefix of expected, or pass a digest made with the chosen algorithm. |
| `toolkit_hash_value` | `sri_unsupported_algorithm` | `ValidationError` | digestEncoding is "sri" and algorithm is md5 or sha1, which SRI does not define. | Use algorithm sha256, sha384, or sha512 for an SRI digest, or set digestEncoding to base64 or hex. |
| `toolkit_hash_value` | `invalid_input_encoding` | `ValidationError` | value is not valid for the declared inputEncoding (e.g. non-hex characters with inputEncoding "hex"). | Input is not valid for the declared inputEncoding. Verify the encoding matches the byte representation. |
| `toolkit_generate_qr` | `data_too_large` | `ValidationError` | data exceeds the QR capacity for the chosen errorCorrection level and encoding mode. | Shorten data, or lower errorCorrection (H→Q→M→L) to raise capacity, then retry. |
| `toolkit_generate_qr` | `raster_too_large` | `ValidationError` | format is png_base64 and (modules + 2 × margin) × scale exceeds the pixel budget. | Lower scale (and margin if needed) so the rendered image stays within 2048 px per side, or request format svg, which has no raster budget. |
| `toolkit_encode_value` | `decode_failed` | `ValidationError` | operation is "decode" but value is malformed for the chosen encoding. | Value isn't valid for the chosen encoding. Verify the encoding matches the input, or switch operation to 'encode'. |
| `toolkit_encode_value` | `decode_not_utf8` | `ValidationError` | operation is "decode", outputEncoding is utf8 (or omitted), and the decoded bytes are not valid UTF-8 text. | The decoded bytes are binary, not UTF-8 text. Retry with outputEncoding 'hex' or 'base64' to receive the raw bytes losslessly. |
| `toolkit_encode_value` | `output_encoding_not_applicable` | `ValidationError` | operation is "encode" and outputEncoding was supplied; it selects how decoded bytes are returned. | outputEncoding applies only to decode. Drop outputEncoding to encode text, or set operation to 'decode'. |
| `toolkit_geolocate_ip` | `unresolvable_host` | `ValidationError` | A hostname target failed DNS resolution. | Hostname didn't resolve. Verify it, or pass an IP address directly. |
| `toolkit_geolocate_ip` | `private_target` | `ValidationError` | The target resolves to a private/reserved IP with no public geolocation. | Private/reserved addresses have no public geolocation. Pass a public IP address. |
| `toolkit_check_network` | `private_target_blocked` | `ValidationError` | The target is private/reserved/loopback/link-local and TOOLKIT_ALLOW_PRIVATE_NETWORK is off. | This target is a private/reserved address. Set TOOLKIT_ALLOW_PRIVATE_NETWORK=true to permit local-network diagnostics. |
| `toolkit_check_network` | `unreachable` | `ServiceUnavailable` | A hostname target could not be resolved, or the ping/traceroute binary could not run in this environment or exited without a result. | Verify the host resolves and the diagnostic binary is available, or try mode connectivity with a port, which uses raw TCP. |
| `toolkit_check_network` | `missing_target` | `ValidationError` | mode is ping, traceroute, or connectivity and no target was supplied. | Pass target as an IPv4/IPv6 address or hostname, or use mode public_ip, which takes no target. |
| `toolkit_check_network` | `missing_port` | `ValidationError` | mode is connectivity and no port was supplied. | Pass port as a separate number (e.g. 443) — connectivity needs one to connect to. |

A host that is simply down is not an error: ping and connectivity report it as `reachable: false`, a valid result the agent acts on. The `unreachable` reason covers only the cases where no diagnosis could run at all. For ping, the dividing line is the packet-loss summary: a run that printed one is a result whatever its exit status, and `reachable` is whether any reply came back (Linux iputils exits 1 on partial loss too), while a binary that never spawned (the error names the binary and its errno, e.g. `ENOENT`) or exited without a summary it could read (the error says the output could not be interpreted and carries its stderr) throws `unreachable`.

`toolkit_generate_id` and `toolkit_check_system` have no domain-specific failure contract — bad input is rejected at the schema as `InvalidParams`, and there's no partial-success or multi-step finalize. `generate_qr`'s two reasons both cover limits the schema cannot express on its own: `data` is capped at `z.string().max(2953)`, a character count that only bounds the real limit — capacity is 2953 UTF-8 bytes at version 40, level L, lower at M/Q/H — and the rendered pixel count is a product of three inputs, so each is checked in the handler and surfaced as a typed reason rather than a raw library failure. `hash_value`'s `expected_without_compare` and `encode_value`'s `output_encoding_not_applicable` reject a contradiction between two supplied fields rather than ignoring one of them, which is also why neither tool gives the discriminating field (`operation`, `outputEncoding`) a schema default: the handler has to see whether it was sent.

---

## Output Design Notes

- **`format()` content-complete on every tool.** Hash → the digest (or match verdict) in a code span; QR `terminal` → the renderable block inside a code fence (so a Markdown client keeps the spaces that are its dark modules), `svg` → the markup, `png_base64` → a note plus byte length (not the full blob inline for PNG); geo → a labeled summary (country, city, ASN/org, coords). Every `output` field the model needs appears in the rendered text — `format-parity` enforces it.
- **Batch ID disclosure.** `toolkit_generate_id` with a large `count` is bounded by `z.number().int().min(1).max(1000)` — not a silently truncated list. `count` is small enough that no truncation/`ctx.enrich.truncated` is needed; the array is always complete.
- **Geolocation preserves uncertainty.** Sparse upstream fields stay nullable in both `structuredContent` and `format()`. The render says "ASN: unknown" rather than omitting or inventing. Tests include a sparse payload (reserved range, free-tier ASN omission).
- **PNG bytes don't bloat context.** `png_base64` returns the base64 string in `content` (the artifact the model can't emit, so it must be returned) but `format()` summarizes ("PNG, {byteLength} bytes, QR version {version}") rather than dumping the base64 into the markdown trailer twice.
- **`source` provenance on geo.** Always report which provider answered, so the agent (and human) can weigh the result.

---

## Known Limitations

- **Geolocation accuracy is provider-bounded.** Keyless ip-api-class data is coarse (city-level at best, often just country/region) and the free tier is rate-limited (~45 req/min); the cache absorbs repeats but a burst of distinct IPs can hit the ceiling → `ServiceUnavailable`. A keyed provider raises both.
- **Geolocation is best-effort, not authoritative.** VPNs, proxies, mobile carrier-grade NAT, and anycast all defeat IP→location. Treat results as a hint.
- **Network diagnostics depend on host environment.** ICMP ping may be blocked by the OS or unavailable in a container without `NET_RAW`; traceroute hop visibility varies; `connectivity` (raw TCP) is the most portable mode. The published Docker image ships neither `ping` nor `traceroute`, so those modes throw `unreachable` there. macOS `ping6` has no deadline flag: it sends one echo a second and then waits a fixed 10 s for the last reply, so an IPv6 ping that gets no answer takes about `count` + 10 seconds, whatever `timeoutMs` says. Ping reads its packet-loss summary in English only; a localized Windows prints it in its own language, so a run with no replies there throws `unreachable` (its output could not be interpreted) rather than reporting the host down, and a responding run reports `reachable: true` without the packet counts or RTT. The hosted profile disables all of this anyway.
- **Container memory depends on the runtime.** Under a cgroup limit, `os.totalmem()`/`os.freemem()` still read the host. Node's `process.availableMemory()` respects the limit but Bun's does not — Bun returns host free memory, the same figure as `os.freemem()` — so `availableBytes` is clamped to the limit minus the cgroup's current usage (`memory.current`, or `memory.usage_in_bytes` on cgroup v1). That usage includes reclaimable page cache, so under a limit the figure is conservative. With no limit, Bun's `availableBytes` equals `freeBytes`; the headroom figure that counts reclaimable pages comes from Node. The usage file is read at `/sys/fs/cgroup`, which inside a container is the container's own cgroup; a process limited by its own cgroup on a bare cgroup-v1 host would read the host-wide figure there and report zero headroom.
- **Workers build is a reduced surface** — no `check_network`/`check_system` (no raw sockets / `os` in a V8 isolate). Documented, not a bug.
- **System info reflects the server host, not the client** — only meaningful on a local/self-hosted deployment, which is why it's gated off by default.
- **md5/sha1 are cryptographically broken** for signatures/passwords. Retained strictly for checksum/compatibility; the description says so.

---

## v1 Scope vs. Deferred

**v1 ships:**

- All seven tools: five always-on (`toolkit_hash_value`, `toolkit_generate_id`, `toolkit_generate_qr`, `toolkit_encode_value`, `toolkit_geolocate_ip`) + two gated (`toolkit_check_network`, `toolkit_check_system`).
- Fail-closed conditional registration + the two-tier network gate.
- `GeoService` with retry/backoff/cache against a keyless default provider; provider/key overridable.
- Node + Cloudflare Workers builds (Workers = reduced surface, documented).
- Full DX: Zod-validated format constraints, typed error contracts, content-complete `format()`, descriptions leading with the criterion-clearing tools.

**Deferred:**

- **Additional hash algorithms** (sha3, blake2/blake3) — add if a real consumer needs them; sha256/512 + md5/sha1-compat cover the field today.
- **Additional ID formats** (nanoid, KSUID, snowflake) — UUIDv4/v7 + ULID cover the common cases.
- **QR decode / read-from-image** — generation is the asymmetric win; decode is rarely asked and the model can often OCR.
- **Richer/keyed geo providers** (MaxMind, ipinfo) as first-class options beyond the override knob.
- **Resources / prompts** — none earn their place in v1; revisit only if a durable entity or recurring workflow emerges.
- **DNS lookup / whois as standalone tools** — out of scope; whois-mcp-server owns that.
