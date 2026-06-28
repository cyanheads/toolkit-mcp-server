/**
 * @fileoverview Tests for the network-target guard — the private/reserved-range
 * classifier (the heart of the two-tier network gate) and the target schema.
 * Locking these down guards against an SSRF regression: 169.254.169.254 (cloud
 * metadata) and RFC-1918 ranges MUST classify as private.
 * @module tests/services/network-target.test
 */

import { describe, expect, it } from 'vitest';
import { isPrivateOrReservedIp, NetworkTargetSchema } from '@/services/network/target.js';

describe('isPrivateOrReservedIp', () => {
  it.each([
    '169.254.169.254', // cloud metadata endpoint — the canonical SSRF target
    '169.254.0.1', // link-local
    '10.0.0.1', // RFC-1918 /8
    '172.16.0.1', // RFC-1918 /12 lower bound
    '172.31.255.255', // RFC-1918 /12 upper bound
    '192.168.1.1', // RFC-1918 /16
    '127.0.0.1', // loopback
    '0.0.0.0', // "this network"
    '100.64.0.1', // CGNAT /10
    '224.0.0.1', // multicast
    '255.255.255.255', // reserved 240.0.0.0/4
    '192.0.0.1', // IETF protocol assignments 192.0.0.0/24
    '192.0.2.1', // TEST-NET-1 192.0.2.0/24
    '198.51.100.1', // TEST-NET-2 198.51.100.0/24
    '203.0.113.7', // TEST-NET-3 203.0.113.0/24 — RFC-5737 documentation, no public geolocation
    '198.18.0.1', // benchmarking 198.18.0.0/15 lower bound
    '198.19.255.255', // benchmarking 198.18.0.0/15 upper bound
    '::1', // IPv6 loopback
    'fe80::1', // IPv6 link-local
    'fd00::1', // IPv6 unique-local
    '2001:db8::1', // IPv6 documentation 2001:db8::/32
    '2001:db8:1234:5678::1', // IPv6 documentation, deeper prefix (not just ::1)
    '2001:2::1', // IPv6 benchmarking 2001:2::/48
    '::ffff:10.0.0.1', // IPv4-mapped IPv6 of a private addr
    '::ffff:203.0.113.7', // IPv4-mapped IPv6 of a TEST-NET addr
  ])('classifies %s as private/reserved', (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1', // just outside the /12
    '172.15.255.255', // just below the /12
    '100.63.255.255', // just below CGNAT
    '198.20.0.1', // just above benchmarking 198.18.0.0/15
    '203.0.114.1', // just outside TEST-NET-3 203.0.113.0/24
    '2001:4860:4860::8888', // public IPv6
  ])('classifies %s as public', (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(false);
  });
});

describe('NetworkTargetSchema', () => {
  it.each([
    '8.8.8.8',
    '203.0.113.7',
    '2001:4860:4860::8888',
    'example.com',
    'db.internal.corp',
  ])('accepts valid target %s', (t) => {
    expect(NetworkTargetSchema.safeParse(t).success).toBe(true);
  });

  it.each([
    'metadata', // bare single-label — could alias an internal name
    'localhost', // single-label
    '', // empty
    'has spaces.com',
    'http://example.com', // a URL, not a hostname/IP
  ])('rejects invalid target %s', (t) => {
    expect(NetworkTargetSchema.safeParse(t).success).toBe(false);
  });
});
