/**
 * @fileoverview Geolocation domain types. Upstream is sparse — most fields are
 * optional because reserved ranges, unrouted IPs, or free-tier providers omit
 * them. Normalization preserves absence; it never fabricates a value.
 * @module services/geo/types
 */

/** Normalized geolocation result. */
export type GeoResult = {
  /** The target as supplied (IP or hostname). */
  target: string;
  /** The IP actually looked up — a supplied hostname is resolved to this first. */
  resolvedIp: string;
  /** ISO 3166-1 country name. */
  country?: string;
  /** ISO 3166-1 alpha-2 country code. */
  countryCode?: string;
  /** Region / state name. */
  region?: string;
  /** City name. */
  city?: string;
  /** Latitude in decimal degrees. */
  latitude?: number;
  /** Longitude in decimal degrees. */
  longitude?: number;
  /** Autonomous System number, e.g. "AS15169". */
  asn?: string;
  /** Owning organization, e.g. "Google LLC". */
  org?: string;
  /** IANA timezone, e.g. "America/Los_Angeles". */
  timezone?: string;
  /** Provider that answered, e.g. "ip-api". */
  source: string;
};

/** Discriminator returned by the service so the tool can map it to a typed contract reason. */
export type GeoFailureReason = 'unresolvable_host' | 'private_target';
