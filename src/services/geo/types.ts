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
  /** Holder name that follows the ASN in the provider's AS string, e.g. "Cloudflare, Inc.". */
  asHolder?: string;
  /** Registry name of the AS, e.g. "CLOUDFLARENET". */
  asName?: string;
  /** Internet service provider, e.g. "Cloudflare, Inc". */
  isp?: string;
  /**
   * Registered organization, e.g. "Google LLC" — often a customer or
   * sub-allocation label. Falls back to the AS holder, then the ISP.
   */
  org?: string;
  /** IANA timezone, e.g. "America/Los_Angeles". */
  timezone?: string;
  /** True when the address is a known proxy, VPN, or Tor exit. Absent when unreported. */
  proxy?: boolean;
  /** True when the address belongs to a hosting or datacenter network. Absent when unreported. */
  hosting?: boolean;
  /** True when the address belongs to a mobile carrier network. Absent when unreported. */
  mobile?: boolean;
  /** Provider that answered, e.g. "ip-api". */
  source: string;
};

/** Discriminator returned by the service so the tool can map it to a typed contract reason. */
export type GeoFailureReason = 'unresolvable_host' | 'private_target';

/** One failed input position; wait metadata is present for quota refusals. */
export type GeoBatchFailure = {
  target: string;
  error: {
    reason: GeoFailureReason | 'rate_limited' | 'provider_unavailable';
    message: string;
    waitTimeSeconds?: number;
    recovery: { hint: string };
  };
};

/** Ordered outcomes for the first 100 positions, with every remainder disclosed. */
export type GeoBatchResult = {
  results: (GeoResult | GeoBatchFailure)[];
  failedCount: number;
  unprocessedTargets: string[];
};
