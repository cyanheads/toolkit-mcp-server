# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [2.0.1](changelog/2.0.x/2.0.1.md) — 2026-06-28

Three bug fixes: a typed data_too_large error for over-capacity QR payloads, strictly-monotonic uuid_v7/ulid batches, and an enforced TOOLKIT_GEO_RATE_LIMIT_PER_MIN throttle.

## [2.0.0](changelog/2.0.x/2.0.0.md) — 2026-06-27 · ⚠️ Breaking

Ground-up rebuild on mcp-ts-core, superseding the 1.0.x line. Five always-on developer utilities (hashing, random IDs, QR codes, value encoding, IP geolocation) plus two fail-closed, off-by-default host diagnostics.
