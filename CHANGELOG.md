# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [2.3.1](changelog/2.3.x/2.3.1.md) — 2026-09-23

toolkit_check_network ping now throws unreachable on a genuine diagnostic failure instead of reporting reachable:false, connectivity gains a typed outcome, and toolkit_check_system memory reports container-aware availableBytes/limitBytes.

## [2.3.0](changelog/2.3.x/2.3.0.md) — 2026-09-23 · ⚠️ Breaking

toolkit_encode_value decode is now byte-exact via outputEncoding, toolkit_hash_value adds sha384/base64/SRI digests, toolkit_generate_qr terminal output drops ANSI escapes, and toolkit_generate_id randomizes same-millisecond id steps.

## [2.2.4](changelog/2.2.x/2.2.4.md) — 2026-09-19

Session mode is now declared in source (createApp({ sessionMode: 'stateless' })), five tools accept common parameter-name aliases, and devcheck gains a README version-badge check and a CodeQL workflow.

## [2.2.3](changelog/2.2.x/2.2.3.md) — 2026-09-13

Declared domain rejections on toolkit_encode_value, toolkit_generate_qr, and toolkit_hash_value now return ValidationError instead of InvalidParams, which mcp-ts-core 0.12.7 reserved for argument rejections; the framework moves to ^0.13.0 and its skill tree to framework-skills/.

## [2.2.2](changelog/2.2.x/2.2.2.md) — 2026-08-22

Dockerfile build stage now runs on $BUILDPLATFORM instead of emulating, fixing the multi-arch GHCR publish that aborted under QEMU — no image reached GHCR for 2.2.1.

## [2.2.1](changelog/2.2.x/2.2.1.md) — 2026-08-22 · ⚠️ Breaking · 🛡️ Security

Framework bumped to mcp-ts-core 0.12.3 (strict-root tool inputs, error-envelope outputSchema, 2020-12 JSON Schema), Bun pinned to 1.4.0, and geo/net-diag upstream-failure logging hardened to stay off the client-visible notification sink.

## [2.2.0](changelog/2.2.x/2.2.0.md) — 2026-08-18 · 🛡️ Security

Windows ping/traceroute fixed, unreachable errors gain their recovery hint, egress-IP failures sanitized, generate_id's read-only annotation corrected, generate_qr adds an image content block and a 2048px raster budget, and encode_value's decoded output can no longer break its Markdown fence.

## [2.1.0](changelog/2.1.x/2.1.0.md) — 2026-08-18 · ⚠️ Breaking · 🛡️ Security

IPv6 private-range guard flipped from denylist to allowlist, provider strings bounded and sanitized, geolocate_ip gains proxy/hosting/mobile flags, geo cache bounded, and TOOLKIT_GEO_PROVIDER removed as a phantom config.

## [2.0.1](changelog/2.0.x/2.0.1.md) — 2026-06-28

Three bug fixes: a typed data_too_large error for over-capacity QR payloads, strictly-monotonic uuid_v7/ulid batches, and an enforced TOOLKIT_GEO_RATE_LIMIT_PER_MIN throttle.

## [2.0.0](changelog/2.0.x/2.0.0.md) — 2026-06-27 · ⚠️ Breaking

Ground-up rebuild on mcp-ts-core, superseding the 1.0.x line. Five always-on developer utilities (hashing, random IDs, QR codes, value encoding, IP geolocation) plus two fail-closed, off-by-default host diagnostics.
