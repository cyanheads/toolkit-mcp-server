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
  .describe('A public IPv4/IPv6 address or a hostname (e.g. "8.8.8.8" or "example.com").');

/**
 * True when `ip` falls in a private, reserved, loopback, link-local,
 * carrier-grade-NAT, or IANA special-use range — i.e. anything with no public
 * geolocation that the network gate blocks by default. Covers both IPv4 and
 * IPv6 forms, including IPv4-mapped IPv6 (`::ffff:a.b.c.d`).
 *
 * IPv4: 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10 (CGNAT), 127.0.0.0/8 (loopback),
 * 169.254.0.0/16 (link-local, incl. the 169.254.169.254 cloud-metadata
 * endpoint), 172.16.0.0/12, 192.0.0.0/24 (IETF protocol assignments),
 * 192.0.2.0/24 (TEST-NET-1), 192.168.0.0/16, 198.18.0.0/15 (benchmarking),
 * 198.51.100.0/24 (TEST-NET-2), 203.0.113.0/24 (TEST-NET-3), 224.0.0.0/4
 * (multicast), and 240.0.0.0/4 (reserved).
 * IPv6: ::/128 (unspecified), ::1/128 (loopback), fe80::/10 (link-local),
 * fc00::/7 (unique-local), ff00::/8 (multicast), 2001:db8::/32 (documentation),
 * and 2001:2::/48 (benchmarking).
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const addr = ip.toLowerCase().trim();

  // IPv6 forms.
  if (addr.includes(':') && !addr.startsWith('::ffff:')) {
    if (addr === '::1' || addr === '::') return true; // loopback / unspecified
    if (addr.startsWith('fe80')) return true; // link-local
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique local (fc00::/7)
    if (addr.startsWith('ff')) return true; // multicast
    // IANA special-use IPv6: documentation (2001:db8::/32) and benchmarking
    // (2001:2::/48). Compare the leading hextets numerically so leading-zero
    // spellings (2001:0db8, 2001:0002) and the `::` compression of a zero third
    // hextet all classify correctly.
    const head = addr.split('::', 1)[0]?.split(':') ?? [];
    const h0 = Number.parseInt(head[0] ?? '', 16);
    const h1 = Number.parseInt(head[1] ?? '', 16);
    const h2 = head[2] === undefined ? 0 : Number.parseInt(head[2], 16);
    if (h0 === 0x2001 && h1 === 0x0db8) return true; // documentation 2001:db8::/32
    if (h0 === 0x2001 && h1 === 0x0002 && h2 === 0x0000) return true; // benchmarking 2001:2::/48
    return false;
  }

  // IPv4 (including the dotted tail of an IPv4-mapped IPv6 address).
  const v4 = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  const octets = v4.split('.');
  if (octets.length !== 4) return false;
  const [a, b, c] = octets.map((o) => Number.parseInt(o, 10));
  if (a === undefined || b === undefined || c === undefined) return false;
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c)) return false;

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 0) return true; // "this network" 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (incl. 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast/reserved 224.0.0.0/4 and 240.0.0.0/4
  // IANA special-use IPv4 — protocol/documentation/benchmarking, no public geolocation.
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1 192.0.2.0/24
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 203.0.113.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15

  return false;
}
