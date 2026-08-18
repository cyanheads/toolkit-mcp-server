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

/** Four octets of an IPv4 address, most-significant first. */
type Octets = [number, number, number, number];

/** The eight 16-bit hextets of a fully expanded IPv6 address. */
type Hextets = [number, number, number, number, number, number, number, number];

/** Parse a dotted quad into four octets, or `undefined` when it isn't one. */
function parseIpv4(value: string): Octets | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return undefined;
    octets.push(octet);
  }
  return octets as Octets;
}

/**
 * Expand an IPv6 address to its eight 16-bit hextets, folding an embedded
 * dotted-quad tail (`::ffff:127.0.0.1`) into the low two hextets so both
 * spellings of one address produce identical output. Returns `undefined` for
 * anything that does not parse; the caller treats that as reserved, so a
 * malformed address is never waved through as public.
 */
function expandIpv6(address: string): Hextets | undefined {
  let text = address;

  // A dotted tail carries the low 32 bits — rewrite it as two hextets up front.
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    if (lastColon === -1) return undefined;
    const octets = parseIpv4(text.slice(lastColon + 1));
    if (!octets) return undefined;
    const [a, b, c, d] = octets;
    const head = text.slice(0, lastColon + 1);
    text = `${head}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const parseGroups = (part: string | undefined): number[] | undefined => {
    if (!part) return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = parseGroups(halves[0]);
  const tail = parseGroups(halves[1]);
  if (!head || !tail) return undefined;

  if (halves.length === 1) return head.length === 8 ? (head as Hextets) : undefined;
  if (head.length + tail.length > 7) return undefined; // `::` must stand for ≥ 1 group
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail] as Hextets;
}

/** Denylist of IANA special-use IPv4 ranges, applied to four parsed octets. */
function isReservedIpv4([a, b, c]: Octets): boolean {
  if (a === 0) return true; // "this network" 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (incl. 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // multicast/reserved 224.0.0.0/4 and 240.0.0.0/4
  // IANA special-use IPv4 — protocol/documentation/benchmarking, no public geolocation.
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast 192.88.99.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 203.0.113.0/24

  return false;
}

/**
 * True when `ip` falls in a private, reserved, loopback, link-local,
 * carrier-grade-NAT, or IANA special-use range — i.e. anything with no public
 * geolocation that the network gate blocks by default.
 *
 * IPv4 is a denylist of special-use ranges: 0.0.0.0/8, 10.0.0.0/8,
 * 100.64.0.0/10 (CGNAT), 127.0.0.0/8 (loopback), 169.254.0.0/16 (link-local,
 * incl. the 169.254.169.254 cloud-metadata endpoint), 172.16.0.0/12,
 * 192.0.0.0/24 (IETF protocol assignments), 192.0.2.0/24 (TEST-NET-1),
 * 192.88.99.0/24 (deprecated 6to4 relay anycast), 192.168.0.0/16,
 * 198.18.0.0/15 (benchmarking), 198.51.100.0/24 (TEST-NET-2), 203.0.113.0/24
 * (TEST-NET-3), 224.0.0.0/4 (multicast), and 240.0.0.0/4 (reserved).
 *
 * IPv6 is an allowlist, because only 2000::/3 is global unicast and a denylist
 * silently passes every block it forgets: an address is public only when it
 * falls inside 2000::/3 and outside the special-use blocks carved out of it —
 * 2001::/32 (Teredo), 2001:2::/48 (benchmarking), 2001:10::/28 (ORCHID),
 * 2001:20::/28 (ORCHIDv2), 2001:db8::/32 and 3fff::/20 (documentation), and
 * 2002::/16 (6to4). Everything else is reserved, which covers ::/128
 * (unspecified), ::1/128 (loopback), fe80::/10 (link-local), fc00::/7
 * (unique-local), ff00::/8 (multicast), 0100::/64 (discard-only), 64:ff9b::/96
 * and 64:ff9b:1::/48 (NAT64), and all unallocated space.
 *
 * IPv4-mapped addresses are classified by their embedded IPv4 in either
 * spelling — dotted (`::ffff:127.0.0.1`) or hex (`::ffff:7f00:1`) — since a
 * dual-stack host routes both to the same IPv4 destination.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const addr = ip.toLowerCase().trim();

  if (!addr.includes(':')) {
    const octets = parseIpv4(addr);
    // Not an IP literal — a hostname is guarded after DNS resolution, not here.
    return octets ? isReservedIpv4(octets) : false;
  }

  const hextets = expandIpv6(addr);
  if (!hextets) return true; // unparseable IPv6 — fail closed
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;

  // IPv4-mapped ::ffff:0:0/96 — classify the embedded 32 bits.
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return isReservedIpv4([h6 >>> 8, h6 & 0xff, h7 >>> 8, h7 & 0xff]);
  }

  // Allowlist: 2000::/3 is the only global-unicast space.
  if ((h0 & 0xe000) !== 0x2000) return true;

  // Special-use blocks carved out of global unicast.
  if (h0 === 0x2001 && h1 === 0x0000) return true; // Teredo 2001::/32
  if (h0 === 0x2001 && h1 === 0x0002 && h2 === 0x0000) return true; // benchmarking 2001:2::/48
  if (h0 === 0x2001 && (h1 & 0xfff0) === 0x0010) return true; // ORCHID 2001:10::/28
  if (h0 === 0x2001 && (h1 & 0xfff0) === 0x0020) return true; // ORCHIDv2 2001:20::/28
  if (h0 === 0x2001 && h1 === 0x0db8) return true; // documentation 2001:db8::/32
  if (h0 === 0x2002) return true; // 6to4 2002::/16
  if (h0 === 0x3fff && (h1 & 0xf000) === 0x0000) return true; // documentation 3fff::/20

  return false;
}
