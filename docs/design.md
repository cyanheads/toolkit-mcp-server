# toolkit-mcp-server — Design

A from-scratch rebuild of the legacy v1.0.1 `toolkit-mcp-server` on mcp-ts-core: a small grab-bag of system and developer utilities, redesigned **fail-closed**. The always-safe tools register everywhere; the two groups that are unsafe on a shared host (network diagnostics, system monitoring) are **off by default behind enable-gates**, so the hosted deployment exposes only what carries no SSRF or info-disclosure risk.

This doc formalizes `docs/idea.md` into a buildable spec. The tool names are fixed — seven tools, five always-on and two gated.

---

## MCP Surface

### Tools

| Tool | Summary | readOnlyHint | openWorldHint | Key inputs | Output shape |
|---|---|---|---|---|---|
| `toolkit_hash_value` | Generate a digest or constant-time-compare a value against an expected digest. | `true` | `false` | `operation` (`generate`\|`compare`), `value`, `algorithm` (`sha256`\|`sha512`\|`sha1`\|`md5`), `expected` (compare only), `inputEncoding` (`utf8`\|`hex`\|`base64` — default `utf8`) | `{ algorithm, operation, digest?, matches?, lengthInBytes? }` |
| `toolkit_generate_id` | Mint cryptographically-random identifiers (UUIDv4/UUIDv7/ULID), single or batch. | `false`¹ | `false` | `type` (`uuid_v4`\|`uuid_v7`\|`ulid`), `count` | `{ type, ids[], count }` |
| `toolkit_generate_qr` | Encode text/URL into a QR code as SVG markup, base64 PNG bytes, or a terminal-renderable string. | `true` | `false` | `data`, `format` (`svg`\|`png_base64`\|`terminal`), `errorCorrection`, `margin`, `scale` | `{ format, content, mimeType?, byteLength?, version }` |
| `toolkit_encode_value` | Encode or decode a value across base64 / base64url / hex / URL. | `true` | `false` | `operation` (`encode`\|`decode`), `encoding`, `value` | `{ encoding, operation, result }` |
| `toolkit_geolocate_ip` | Resolve a public IP (or hostname) to geographic and network metadata via an external geo API. | `true` | `true` | `target` (IPv4/IPv6/hostname) | `{ target, resolvedIp, country, countryCode, region, city, latitude, longitude, asn, org, timezone, source }` |
| `toolkit_check_network` | **Gated.** Network diagnostics — ping, traceroute, TCP connectivity, or host egress-IP detection. | `true` | `true` | `mode` (`ping`\|`traceroute`\|`connectivity`\|`public_ip`), `target` (required for all modes except `public_ip`), `port` (connectivity only), `count`, `timeoutMs` | `{ mode, target?, reachable?, hops?, rttMs?, publicIp? }` |
| `toolkit_check_system` | **Gated.** Host system facts — OS, CPU, memory, load average, or network interfaces. | `true` | `false` | `what` (`os`\|`cpu`\|`memory`\|`load`\|`interfaces`) | `{ what, ...facetFields }` |

¹ `toolkit_generate_id` is `readOnlyHint: false` deliberately: each call produces fresh non-idempotent entropy (the whole point). It performs no external I/O, so `openWorldHint: false` and `idempotentHint: false`.

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
- Hashing supports sha256 (default), sha512, sha1, md5. `compare` is **constant-time** (`crypto.timingSafeEqual`). md5/sha1 are exposed for checksum/compatibility only and the description must say "not for security". `inputEncoding` (`utf8` default | `hex` | `base64`) controls how `value` and `expected` are interpreted before hashing — necessary so the agent can hash raw binary data supplied as hex or base64 without round-tripping through a decode step.
- ID generation uses the platform CSPRNG for all three types and supports batch via `count` (Zod `.max(1000)` — large enough for any realistic batch, small enough to keep the response inline without truncation).
- QR generation emits SVG (text), base64-encoded PNG, or a terminal string, with configurable error-correction level, quiet-zone margin, and module scale.
- Encoding covers base64, base64url, hex, URL — both directions.
- Geolocation accepts an IP **or** a hostname, resolves to country/region/city, lat/lon, ASN/org, timezone, and reports its `source` provider. It is cached and rate-limited.
- `toolkit_check_network` supports `ping`, `traceroute`, `connectivity` (TCP reachability — host via `target`, port via separate `port` param, not inline `host:port` syntax), and `public_ip` (host egress IP — `target` is absent/ignored for this mode). Private/reserved/loopback/link-local targets are **rejected** unless `TOOLKIT_ALLOW_PRIVATE_NETWORK=true`.
- `toolkit_check_system` reports host OS, CPU, memory, load, or interfaces.

**Non-functional**

- **Fail-closed.** Enable-flags default `false`. The hosted profile sets none → only the five always-on tools exist.
- **Two-tier network gate.** Even with net-diag enabled, private/reserved destinations need the second explicit `TOOLKIT_ALLOW_PRIVATE_NETWORK` gate. This blocks the cloud-metadata endpoint (`169.254.169.254`) and internal-`10.x`/`172.16/12`/`192.168` recon vectors.
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
/** Hash result. `digest` is lowercase hex; `matches` only on operation:'compare'. */
type HashResult = {
  algorithm: 'sha256' | 'sha512' | 'sha1' | 'md5';
  operation: 'generate' | 'compare';
  digest?: string;          // generate: lowercase hex digest
  matches?: boolean;        // compare: constant-time equality result
  lengthInBytes?: number;   // digest byte length (32 for sha256, 64 for sha512, …)
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
  rttMs?: number;            // ping: round-trip time in milliseconds
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

**Network identifiers.** Targets are caller-supplied IPv4/IPv6/hostnames — validated by Zod via `z.union([z.string().ip(), z.string().regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/)])` (covers both raw IPs and valid hostnames; rejects bare single-label strings that could alias metadata endpoints). Never minted here. The agent obtains them from its own context (a log line, a URL, a prior tool); the server adds no resolver step beyond `geolocate`/`check_network` doing their own DNS. The private-range guard runs **after** DNS resolution so a hostname can't smuggle a private IP past the Zod validator.

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
| Backoff | 1–2 s base (default calibrated to the keyless ip-api tier, ~45 req/min; `TOOLKIT_GEO_RATE_LIMIT_PER_MIN` tunes this for higher-tier providers). |
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
| `TOOLKIT_GEO_PROVIDER` | No | `ip-api` | Geolocation provider id. Default is the keyless tier — zero-config hosted profile. |
| `TOOLKIT_GEO_API_KEY` | No | — | API key, **if** the chosen provider needs one. Absent + keyless provider → degrades to the rate-limited free tier (still functional). Absent + key-required provider → `geolocate` throws a `ConfigurationError`-class startup/first-call failure naming the variable. |
| `TOOLKIT_GEO_BASE_URL` | No | `http://ip-api.com` | Base URL for the geo provider. Override to point at an ip-api pro endpoint or an alternate keyless-compatible provider. |
| `TOOLKIT_GEO_CACHE_TTL_SECONDS` | No | `3600` | GeoService cache TTL. |
| `TOOLKIT_GEO_RATE_LIMIT_PER_MIN` | No | `45` | Max geo-API requests per minute before the backoff slows. Default matches ip-api free tier (~45 req/min). Raise when using a keyed or higher-tier provider. |

**Degraded behavior without keys:** the default (`ip-api`, no key) is fully functional at the free rate limit. A key only raises the ceiling or unlocks a richer provider. Nothing else in the server takes config — the four pure-compute tools are zero-config by construction.

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
| 1 | `toolkit_hash_value` `{ operation: 'compare', algorithm: 'sha256', value: <downloaded-bytes-or-hex>, expected: <vendor-digest> }` | Constant-time compare in one call — the agent does **not** call `generate` then eyeball-match; `compare` is the safe path. |

The lesson the description must teach: use `operation: 'compare'` with `expected`, not `generate` + manual string equality (timing-unsafe, error-prone for the model).

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
- **`generate_id` is `readOnlyHint: false`.** It produces fresh, non-reproducible entropy and is explicitly *not* idempotent — that's the feature. Marking it read-only would wrongly invite auto-approval as a side-effect-free call when its whole value is unrepeatable output.
- **md5/sha1 stay, flagged.** Not a host-security risk (checksums here, not password/signature crypto); dropping them breaks legit file-integrity checks against vendor-published MD5s. Default to sha256; the description says "checksum/compat only — not for security." Keeping them avoids forcing the agent to a sandbox for a routine vendor-checksum match.
- **`compare` is constant-time.** `crypto.timingSafeEqual`, exposed as a first-class operation so the model never reaches for timing-unsafe string equality.
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
| `toolkit_hash_value` | `missing_expected` | `InvalidParams` | `operation: 'compare'` with no `expected` digest | "Provide `expected` (the digest to compare against) when operation is 'compare'." |
| `toolkit_hash_value` | `expected_length_mismatch` | `InvalidParams` | `expected` length ≠ the algorithm's digest length (compare would always fail) | "The expected digest length doesn't match {algorithm}. Check the algorithm or the expected value." |
| `toolkit_hash_value` | `invalid_input_encoding` | `InvalidParams` | `value` or `expected` is not valid for the declared `inputEncoding` (e.g. non-hex chars when `inputEncoding: 'hex'`) | "Input is not valid {inputEncoding}. Verify the encoding matches the actual byte representation." |
| `toolkit_encode_value` | `decode_failed` | `InvalidParams` | `operation: 'decode'` on a value malformed for `encoding` | "Value isn't valid {encoding}. Verify the encoding matches the input, or switch operation to 'encode'." |
| `toolkit_geolocate_ip` | `unresolvable_host` | `InvalidParams` | hostname target fails DNS resolution | "Hostname didn't resolve. Verify it, or pass an IP address directly." |
| `toolkit_geolocate_ip` | `private_target` | `InvalidParams` | target resolves to a private/reserved IP (no public geolocation exists for RFC-1918/reserved ranges) | "Private/reserved addresses have no public geolocation. Pass a public IP." |
| `toolkit_check_network` | `private_target_blocked` | `InvalidParams` | target is private/reserved/loopback/link-local and `TOOLKIT_ALLOW_PRIVATE_NETWORK` is off | "This target is a private/reserved address. Set TOOLKIT_ALLOW_PRIVATE_NETWORK=true to permit local-network diagnostics." |
| `toolkit_check_network` | `unreachable` | (success, not error) | ping/connectivity finds the host down | — reported as `reachable: false` in output, **not** thrown; an unreachable host is a valid result the agent acts on. |

`toolkit_generate_id`, `toolkit_generate_qr`, and `toolkit_check_system` have no domain-specific failure contract — bad input is caught by Zod (`ValidationError`), and there's no partial-success or multi-step finalize. (`generate_qr` data exceeding QR capacity surfaces as a `ValidationError` from the encoder; cap `data` at `z.string().max(2953)` — the byte limit for a QR version 40 at error-correction level L, which is the absolute ceiling; realistically usable data fits well under this, but the cap prevents encoding failures from the library while the Zod error message explains the constraint.)

---

## Output Design Notes

- **`format()` content-complete on every tool.** Hash → the digest (or match verdict) in a code span; QR `terminal` → the renderable block, `svg`/`png_base64` → a note plus byte length (not the full blob inline for PNG); geo → a labeled summary (country, city, ASN/org, coords). Every `output` field the model needs appears in the rendered text — `format-parity` enforces it.
- **Batch ID disclosure.** `toolkit_generate_id` with a large `count` is bounded by `z.number().int().min(1).max(1000)` — not a silently truncated list. `count` is small enough that no truncation/`ctx.enrich.truncated` is needed; the array is always complete.
- **Geolocation preserves uncertainty.** Sparse upstream fields stay nullable in both `structuredContent` and `format()`. The render says "ASN: unknown" rather than omitting or inventing. Tests include a sparse payload (reserved range, free-tier ASN omission).
- **PNG bytes don't bloat context.** `png_base64` returns the base64 string in `content` (the artifact the model can't emit, so it must be returned) but `format()` summarizes ("PNG, {byteLength} bytes, QR version {version}") rather than dumping the base64 into the markdown trailer twice.
- **`source` provenance on geo.** Always report which provider answered, so the agent (and human) can weigh the result.

---

## Known Limitations

- **Geolocation accuracy is provider-bounded.** Keyless ip-api-class data is coarse (city-level at best, often just country/region) and the free tier is rate-limited (~45 req/min); the cache absorbs repeats but a burst of distinct IPs can hit the ceiling → `ServiceUnavailable`. A keyed provider raises both.
- **Geolocation is best-effort, not authoritative.** VPNs, proxies, mobile carrier-grade NAT, and anycast all defeat IP→location. Treat results as a hint.
- **Network diagnostics depend on host environment.** ICMP ping may be blocked by the OS or unavailable in a container without `NET_RAW`; traceroute hop visibility varies; `connectivity` (raw TCP) is the most portable mode. The hosted profile disables all of this anyway.
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
