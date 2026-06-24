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
    '::1', // IPv6 loopback
    'fe80::1', // IPv6 link-local
    'fd00::1', // IPv6 unique-local
    '::ffff:10.0.0.1', // IPv4-mapped IPv6 of a private addr
  ])('classifies %s as private/reserved', (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '203.0.113.7',
    '172.32.0.1', // just outside the /12
    '172.15.255.255', // just below the /12
    '100.63.255.255', // just below CGNAT
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
