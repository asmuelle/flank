// Pure network-policy predicates for the fetch layer. No I/O: DNS resolution and HTTP live in the
// pipeline's HttpFetcher, which calls these to decide what it is allowed to reach. Kept here because
// SSRF classification and the legal-source policy (Invariant 4) are security-critical domain rules.

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
};

/** Precompute a CIDR as [networkStart, mask]. Bases are known-valid literals (cast past the null). */
const cidr = (base: string, prefix: number): readonly [number, number] => {
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return [(ipv4ToInt(base) as number) & mask, mask];
};

/** IPv4 ranges an outbound fetch must never reach (private, loopback, link-local incl. cloud
 * metadata 169.254.169.254, CGNAT, test-nets, multicast, reserved). */
const BLOCKED_V4: ReadonlyArray<readonly [number, number]> = [
  cidr('0.0.0.0', 8),
  cidr('10.0.0.0', 8),
  cidr('100.64.0.0', 10),
  cidr('127.0.0.0', 8),
  cidr('169.254.0.0', 16),
  cidr('172.16.0.0', 12),
  cidr('192.0.0.0', 24),
  cidr('192.0.2.0', 24),
  cidr('192.168.0.0', 16),
  cidr('198.18.0.0', 15),
  cidr('198.51.100.0', 24),
  cidr('203.0.113.0', 24),
  cidr('224.0.0.0', 4),
  cidr('240.0.0.0', 4),
];

const isBlockedIpv4 = (ip: string): boolean => {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  return BLOCKED_V4.some(([networkStart, mask]) => (ipInt & mask) === networkStart);
};

const isBlockedIpv6 = (ip: string): boolean => {
  const lower = ip.toLowerCase();
  // IPv4-mapped/compatible (::ffff:a.b.c.d / ::a.b.c.d): classify the embedded IPv4.
  const mapped = /(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/.exec(lower);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (lower === '::' || lower === '::1') return true; // unspecified, loopback
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique-local
  if (lower.startsWith('ff')) return true; // ff00::/8 multicast
  return false;
};

/** True when `value` is a syntactically valid IPv4 or IPv6 literal. */
export const isIpAddress = (value: string): boolean =>
  ipv4ToInt(value) !== null || (value.includes(':') && /^[0-9a-f:.]+$/i.test(value));

/**
 * True when an IP address must not be the target of an outbound fetch (SSRF guard). Callers resolve
 * a hostname to its addresses and reject the request if ANY resolved address is blocked, defeating
 * DNS-rebinding by validating every result rather than just the first.
 */
export const isBlockedIpAddress = (ip: string): boolean =>
  ip.includes(':') ? isBlockedIpv6(ip) : isBlockedIpv4(ip);

/** Review platforms whose scraping is ToS-prohibited (Invariant 4): license or skip, never crawl. */
const PROHIBITED_HOSTS: readonly string[] = [
  'g2.com',
  'capterra.com',
  'trustradius.com',
  'getapp.com',
  'softwareadvice.com',
];

/** True when `host` (or any subdomain of it) is on the prohibited-source denylist (Invariant 4). */
export const isProhibitedSourceHost = (host: string): boolean => {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return PROHIBITED_HOSTS.some(
    (denied) => normalized === denied || normalized.endsWith(`.${denied}`),
  );
};
