/**
 * @fileoverview Network-target validation shared across geo + net-diag tools.
 * Provides the Zod schema for an IPv4/IPv6/hostname target, and the
 * private/reserved-range classifier used by the two-tier network gate.
 * @module services/network/target
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * A network target: a raw IPv4/IPv6 address OR a multi-label hostname.
 * The hostname regex requires at least one dot, so bare single-label strings
 * (which could alias internal/metadata names like `metadata`) are rejected at
 * the schema boundary. Private-range filtering happens after DNS resolution,
 * not here — a hostname can resolve to a private IP that this regex can't see.
 */
export const NetworkTargetSchema = z
  .union([
    z.ipv4().describe('A raw IPv4 address.'),
    z.ipv6().describe('A raw IPv6 address.'),
    z
      .string()
      .regex(
        /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/,
        'Must be a valid IPv4/IPv6 address or a dotted hostname (e.g. "example.com").',
      )
      .describe('A dotted hostname, e.g. "example.com".'),
  ])
  .describe('A public IPv4/IPv6 address or a hostname (e.g. "203.0.113.7" or "example.com").');

/**
 * True when `ip` falls in a private, reserved, loopback, link-local, or
 * carrier-grade-NAT range — i.e. anything with no public geolocation and that
 * the network gate blocks by default. Covers both IPv4 and IPv6 forms,
 * including IPv4-mapped IPv6 (`::ffff:a.b.c.d`).
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const addr = ip.toLowerCase().trim();

  // IPv6 forms.
  if (addr.includes(':') && !addr.startsWith('::ffff:')) {
    if (addr === '::1' || addr === '::') return true; // loopback / unspecified
    if (addr.startsWith('fe80')) return true; // link-local
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique local (fc00::/7)
    if (addr.startsWith('ff')) return true; // multicast
    return false;
  }

  // IPv4 (including the dotted tail of an IPv4-mapped IPv6 address).
  const v4 = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  const octets = v4.split('.');
  if (octets.length !== 4) return false;
  const [a, b] = octets.map((o) => Number.parseInt(o, 10));
  if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) return false;

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 0) return true; // "this network" 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (incl. 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast/reserved 224.0.0.0/4 and 240.0.0.0/4

  return false;
}
