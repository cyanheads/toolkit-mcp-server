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
    '192.88.99.1', // deprecated 6to4 relay anycast 192.88.99.0/24 (RFC 7526)
  ])('classifies %s as private/reserved', (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  // Hex-tail IPv4-mapped IPv6: the same 32 embedded bits as the dotted form, so
  // it must classify identically. A dual-stack host routes these to the embedded
  // IPv4 destination, which is what makes the dotted-only de-mapping a bypass.
  it.each([
    ['::ffff:7f00:1', '::ffff:127.0.0.1'], // loopback
    ['::ffff:a9fe:a9fe', '::ffff:169.254.169.254'], // cloud metadata
    ['::ffff:a00:1', '::ffff:10.0.0.1'], // RFC-1918 /8
    ['::ffff:c0a8:101', '::ffff:192.168.1.1'], // RFC-1918 /16
    ['::ffff:6440:1', '::ffff:100.64.0.1'], // CGNAT
    ['::ffff:cb00:7107', '::ffff:203.0.113.7'], // TEST-NET-3
    ['::ffff:0000:0000', '::ffff:0.0.0.0'], // "this network", zero-padded hextets
  ])('classifies hex-mapped %s the same as dotted %s', (hex, dotted) => {
    expect(isPrivateOrReservedIp(dotted)).toBe(true);
    expect(isPrivateOrReservedIp(hex)).toBe(true);
  });

  // IPv6 is an allowlist: public only inside 2000::/3, minus the special-use
  // blocks carved out of it. Everything else — including unallocated space — is
  // reserved, so a missed range can never be forwarded as if it were routable.
  it.each([
    '2002:7f00:1::', // 6to4 2002::/16, embedding 127.0.0.1
    '2002::1', // 6to4, lower bound
    '2001::1', // Teredo 2001::/32
    '2001:0:53aa:64c:2c:1234:5678:9abc', // Teredo, full-form spelling
    '2001:10::1', // ORCHID 2001:10::/28 (deprecated)
    '2001:1f:ffff:ffff:ffff:ffff:ffff:ffff', // ORCHID, upper bound of the /28
    '2001:20::1', // ORCHIDv2 2001:20::/28
    '2001:2f::1', // ORCHIDv2, upper bound of the /28
    '3fff::1', // documentation 3fff::/20 (RFC 9637)
    '3fff:fff:ffff::1', // documentation, upper bound of the /20
    '0100::1', // discard-only 0100::/64
    '64:ff9b::1.2.3.4', // NAT64 well-known prefix 64:ff9b::/96
    '64:ff9b:1::1', // local-use NAT64 64:ff9b:1::/48
    '4000::1', // unallocated — outside 2000::/3
    '8000::1', // unallocated — outside 2000::/3
    'febf::1', // link-local upper bound: fe80::/10 runs to febf, not just fe80
    'ff02::1', // multicast
    '::', // unspecified
  ])('classifies IPv6 %s as reserved', (ip) => {
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
    '192.88.98.1', // just below the 6to4 relay anycast /24
    '192.88.100.1', // just above the 6to4 relay anycast /24
    '2001:4860:4860::8888', // global unicast — Google public DNS
    '2606:4700:4700::1111', // global unicast — Cloudflare public DNS
    '2003::1', // global unicast, immediately above the 6to4 block
    '2000::1', // global unicast, lower bound of 2000::/3
    '3ffe::1', // global unicast, immediately below the 3fff::/20 doc block
    '::ffff:8.8.8.8', // IPv4-mapped form of a public address
    '::ffff:808:808', // hex-mapped form of the same public address
  ])('classifies %s as public', (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(false);
  });
});

describe('NetworkTargetSchema', () => {
  it.each(['8.8.8.8', '203.0.113.7', '2001:4860:4860::8888', 'example.com', 'db.internal.corp'])(
    'accepts valid target %s',
    (t) => {
      expect(NetworkTargetSchema.safeParse(t).success).toBe(true);
    },
  );

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
