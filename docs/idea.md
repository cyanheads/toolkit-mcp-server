# toolkit-mcp-server — Idea & Design

A from-scratch rebuild of the legacy v1.0.1 `toolkit-mcp-server` on mcp-ts-core — a small grab-bag of system and developer utilities, redesigned fail-closed. The original shipped everything on by default; this version inverts that: the always-safe tools are exposed everywhere, and the two groups that are unsafe on a shared host (network diagnostics, system monitoring) are **off by default behind enable-gates**, so the hosted deployment exposes only what carries no SSRF or info-disclosure risk.

Honest framing carried from the design thread: a utility server fights the agent-self-serve headwind — a code-capable agent hashes a string or base64s a blob inline. The tools that *durably* earn a call are the ones it can't self-serve: **QR generation** (artifact bytes the model can't emit), **ID generation** (real CSPRNG entropy — the model is a poor RNG), and **IP geolocation** (external data). The hash/compare tools are kept because they're cheap, complete the set, and have real value in chat clients with no code sandbox.

**Audience:** agents and their humans wanting quick utilities without leaving the conversation — hash a value, mint IDs, make a QR, locate an IP. Network/system tools serve local-deployment operators (diagnostics on their own machine/network), which is exactly why they're gated off when hosted.

## Capabilities & security posture

The heart of the rebuild — every legacy capability, classified by risk on a shared host and its treatment:

| Capability | Risk when hosted | Treatment |
|:-----------|:-----------------|:----------|
| Hash generate / constant-time compare | None (pure compute) | **Always on** |
| Encoding / decoding (base64, hex, URL) | None (pure compute) | **Always on** |
| ID generation (UUID/ULID) | None (uses CSPRNG — a feature) | **Always on** |
| QR code generation | None (pure compute; artifact output) | **Always on** |
| IP geolocation | Low (public data; server calls the geo API, not the target — no SSRF) | **Always on**, cached + rate-limited |
| Public-IP detection | Low-med (leaks the host's egress IP) | **Gated** (folded into net-diag) |
| Network diagnostics — ping / traceroute / connectivity | **SSRF / internal recon** — can probe `169.254.169.254`, internal `10.x`, sibling containers | **Gated off**; when on, private/reserved/loopback/link-local targets blocked unless a second explicit gate |
| System monitoring — OS / CPU / memory / load / interfaces | **Info disclosure** — leaks host specs, OS version (→ targeting), internal interface IPs (→ topology) | **Gated off**; only meaningful on a local deployment |

Nothing is dropped outright — each risky tool is legitimately useful on a *local* deployment, so gating beats deletion. The drop line sits past this surface: a bulk port-scanner, arbitrary-command exec, or arbitrary-URL fetch would not belong here at all — offensive/recon net work lives in `pentest-mcp-server` under its authorized-use framing.

## Tool Surface (sketch)

Consolidated framework-native, `{prefix}_{verb}_{noun}` with mode enums where ops share a noun.

```
toolkit_hash_value      — operation: 'generate' | 'compare'. algorithm: sha256 (default)
                          | sha512 | sha1 | md5. compare is constant-time. md5/sha1 are
                          checksum/compat ONLY — description flags them not-for-security.
                          Always available.

toolkit_generate_id     — type: 'uuid_v4' (default) | 'uuid_v7' | 'ulid'. count for batch.
                          Platform CSPRNG — the real reason to call a tool instead of letting
                          the model invent "random" values. Always available.

toolkit_generate_qr     — data + format: 'svg' (text) | 'png_base64' | 'terminal'.
                          errorCorrection, margin, scale. The artifact the model can't type.
                          Always available.

toolkit_encode_value    — encoding: 'base64' | 'base64url' | 'hex' | 'url'. operation:
                          'encode' | 'decode'. Pure compute — no self-serve in chat clients
                          without a code sandbox. Always available.

toolkit_geolocate_ip    — IP (or hostname) → country/region/city, lat/lon, ASN/org, timezone.
                          One external geo API; cached, rate-limited. Safe — no SSRF.
                          Always available.

toolkit_check_network   — GATED (TOOLKIT_ENABLE_NET_DIAGNOSTICS). mode: 'ping' | 'traceroute'
                          | 'connectivity' (host[:port]) | 'public_ip'. Rejects private/reserved
                          targets unless TOOLKIT_ALLOW_PRIVATE_NETWORK. Node-only (raw sockets)
                          — absent on the Workers build.

toolkit_check_system    — GATED (TOOLKIT_ENABLE_SYSTEM_INFO). what: 'os' | 'cpu' | 'memory'
                          | 'load' | 'interfaces'. Reports the HOST — useful locally, off on
                          the hosted profile. Node-only.
```

## Config (the security gates)

Fail-closed: these are **enable** flags defaulting off, not disable flags defaulting on. The hosted profile sets none → only the five always-on tools register.

| Env var | Default | Effect |
|:--------|:--------|:-------|
| `TOOLKIT_ENABLE_NET_DIAGNOSTICS` | `false` | Registers `toolkit_check_network` |
| `TOOLKIT_ENABLE_SYSTEM_INFO` | `false` | Registers `toolkit_check_system` |
| `TOOLKIT_ALLOW_PRIVATE_NETWORK` | `false` | (net-diag on) permits private/reserved/loopback targets — the second, explicit gate for legit local-network diagnostics |
| `TOOLKIT_GEO_API_KEY` | — | Key for the ip-api-compatible geolocation endpoint, if it needs one |

## Design Notes

- **Fail-closed is the whole point of the rebuild.** Gated tools are *not registered* when their flag is off — they're invisible in `tools/list`, not present-but-erroring. An agent on the hosted deployment can't even see net-diag/system-info. This inverts the legacy server's everything-on default and is the direct answer to "disable env vars for the insecure ones."
- **Two-tier network gate.** Enabling net-diag still blocks RFC-1918 / reserved / loopback / link-local destinations by default; reaching internal hosts needs the *second* `TOOLKIT_ALLOW_PRIVATE_NETWORK` gate. This kills the cloud-metadata-endpoint (`169.254.169.254`) and internal-recon SSRF vectors even when diagnostics are intentionally on.
- **Runtime split (mirror whois).** `toolkit_check_network` (raw sockets) and `toolkit_check_system` (`os`/`process`) are Node-only. The Cloudflare Workers build carries only hash + id + encode + qr + geolocate (all HTTPS/pure-compute). Document it so the hosted-on-Workers path isn't expected to diagnose networks.
- **MD5/SHA-1 stay, flagged.** Not a host-security risk (they're checksums here, not password/signature crypto), and dropping them breaks legit file-integrity checks against vendor-published MD5s. Keep them, default to sha256, and say "checksum/compat only — not for security" in the description.
- **ID gen and QR are the criterion-clearing tools** — entropy the model shouldn't fake, and bytes it can't emit. Lead the README and tool descriptions with those, not with hashing.
- **Geolocation is the lone external dep**, so it's the only tool with a resilience layer (retry/backoff/cache); the rest are local and synchronous. Pick a keyless-tier provider (ip-api class) to keep the hosted profile zero-config.
- **Supersedes, not migrates.** The legacy v1.0.1 codebase isn't ported — this is a clean framework build. When it ships, flip status to active and the legacy repo gets the standard deprecation pointer.
