import { describe, expect, it } from 'vitest';
import { clientKey, ipv6Prefix64 } from '../src/worker/client_key';

const request = (address?: string) =>
  new Request('https://markasso.it/api/share', {
    headers: address ? { 'CF-Connecting-IP': address } : {},
  });

describe('client key', () => {
  it('is the address for IPv4, unknown without one', () => {
    expect(clientKey(request('203.0.113.7'))).toBe('203.0.113.7');
    expect(clientKey(request())).toBe('unknown');
  });

  it('is the /64 for IPv6, whatever the rest of the address', () => {
    expect(clientKey(request('2001:db8:0:1:aaaa::5'))).toBe(
      '2001:db8:0:1::/64',
    );
    expect(clientKey(request('2001:0DB8:0000:0001:ffff:0:0:9'))).toBe(
      '2001:db8:0:1::/64',
    );
    expect(ipv6Prefix64('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipv6Prefix64('::1')).toBe('0:0:0:0::/64');
    expect(ipv6Prefix64('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('counts an IPv4-mapped address as its IPv4 address', () => {
    expect(ipv6Prefix64('::ffff:192.0.2.1')).toBe('192.0.2.1');
  });

  it('keeps an address it cannot parse as it is', () => {
    expect(ipv6Prefix64('2001:db8::1::2')).toBe('2001:db8::1::2');
    expect(ipv6Prefix64('2001:db8:zz::1')).toBe('2001:db8:zz::1');
  });
});
