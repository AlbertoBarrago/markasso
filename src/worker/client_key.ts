/**
 * The key a rate limit counts a client by. An IPv4 address is the client;
 * an IPv6 address counts as its /64, since a single connection usually gets
 * a whole /64 and could rotate addresses within it to dodge a per-address
 * limit.
 */
export function clientKey(request: Request): string {
  const address = request.headers.get('CF-Connecting-IP');
  if (!address) return 'unknown';
  return address.includes(':') ? ipv6Prefix64(address) : address;
}

/**
 * The /64 prefix of an IPv6 address, normalized (`2001:db8:0:1::/64`), or
 * the address itself when it does not parse. An IPv4-mapped address
 * (`::ffff:192.0.2.1`) is its IPv4 address.
 */
export function ipv6Prefix64(address: string): string {
  const addr = address.split('%')[0]!.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return mapped[1]!;
  // A dotted IPv4 tail counts as the last two groups.
  const groupsText = addr.replace(/:\d{1,3}(?:\.\d{1,3}){3}$/, ':0:0');
  const halves = groupsText.split('::');
  if (halves.length > 2) return addr;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return addr;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return addr;
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}
