# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
