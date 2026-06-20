import { describe, expect, it } from 'vitest';
import { isBlockedIpAddress, isIpAddress, isProhibitedSourceHost } from './net-policy';

describe('isBlockedIpAddress (SSRF guard)', () => {
  it('blocks private, loopback, link-local, CGNAT and reserved IPv4', () => {
    const blocked = [
      '0.0.0.0',
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1', // CGNAT
      '127.0.0.1',
      '169.254.169.254', // cloud metadata
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '198.18.0.1',
      '224.0.0.1', // multicast
      '240.0.0.1', // reserved
    ];
    for (const ip of blocked) {
      expect(isBlockedIpAddress(ip)).toBe(true);
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1']) {
      expect(isBlockedIpAddress(ip)).toBe(false);
    }
  });

  it('blocks loopback, link-local and unique-local IPv6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1']) {
      expect(isBlockedIpAddress(ip)).toBe(true);
    }
  });

  it('unwraps IPv4-mapped IPv6 and classifies the embedded address', () => {
    expect(isBlockedIpAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIpAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedIpAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows ordinary public IPv6', () => {
    expect(isBlockedIpAddress('2606:4700:4700::1111')).toBe(false);
  });
});

describe('isIpAddress', () => {
  it('recognises IPv4 and IPv6 literals, rejects hostnames and malformed input', () => {
    expect(isIpAddress('10.0.0.1')).toBe(true);
    expect(isIpAddress('::1')).toBe(true);
    expect(isIpAddress('2606:4700::1111')).toBe(true);
    expect(isIpAddress('example.com')).toBe(false);
    expect(isIpAddress('999.1.1.1')).toBe(false); // octet out of range
    expect(isIpAddress('1.2.3.x')).toBe(false); // non-numeric octet
    expect(isIpAddress('zz::')).toBe(false); // colon but non-hex
  });

  it('classifies a non-IP string as not-blocked (callers only pass resolved addresses)', () => {
    expect(isBlockedIpAddress('not-an-ip')).toBe(false);
  });
});

describe('isProhibitedSourceHost (Invariant 4)', () => {
  it('blocks the review-platform denylist and their subdomains', () => {
    for (const host of ['g2.com', 'www.g2.com', 'capterra.com', 'reviews.capterra.com', 'G2.COM']) {
      expect(isProhibitedSourceHost(host)).toBe(true);
    }
  });

  it('allows legal-graph hosts', () => {
    for (const host of [
      'example.com',
      'boards-api.greenhouse.io',
      'notg2.com',
      'g2.com.evil.com',
    ]) {
      expect(isProhibitedSourceHost(host)).toBe(false);
    }
  });
});
