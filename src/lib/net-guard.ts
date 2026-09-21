// SSRF guard for outbound fetches to admin-configured URLs (pull connectors).
//
// An admin sets a data source's endpoint_url; without a guard, a URL like
// http://169.254.169.254/ (cloud metadata) or http://10.0.0.5/ could make the
// server fetch internal resources. This blocks link-local, loopback, private,
// and other non-public destinations — checking BOTH a literal-IP host and the
// DNS-resolved addresses of a hostname (so a public name pointing at a private
// IP is caught too).

import net from "node:net";
import { lookup } from "node:dns/promises";

/** True for IPv4/IPv6 addresses that must never be fetched from a server. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    return (
      a === 0 || // "this" network
      a === 10 || // private
      a === 127 || // loopback
      a === 169 && b === 254 || // link-local incl. 169.254.169.254 metadata
      a === 172 && b >= 16 && b <= 31 || // private
      a === 192 && b === 168 || // private
      a === 100 && b >= 64 && b <= 127 || // CGNAT
      a >= 224 // multicast / reserved / broadcast
    );
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (s === "::1" || s === "::") return true; // loopback / unspecified
    if (s.startsWith("fe80") || s.startsWith("fec") || s.startsWith("fed") || s.startsWith("fee") || s.startsWith("fef")) return true; // link-local / site-local
    if (s.startsWith("fc") || s.startsWith("fd")) return true; // unique-local
    if (s.startsWith("2002:")) return true; // 6to4 (embeds an arbitrary v4)
    if (s.startsWith("64:ff9b:")) return true; // NAT64 (embeds an arbitrary v4)
    if (s.startsWith("ff")) return true; // multicast
    // IPv4-mapped / -compatible addresses embed a v4 — dotted (::ffff:127.0.0.1)
    // OR hex form, which is how the URL parser serialises them (::ffff:7f00:1).
    const dotted = s.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return false;
  }
  return true; // not a valid IP → treat as unsafe
}

/**
 * Throw if `urlStr` is not a safe, public http(s) URL. Resolves the hostname and
 * rejects if ANY resolved address is private/loopback/link-local. Call before
 * fetching an admin-supplied endpoint.
 */
export async function assertPublicUrl(urlStr: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error(`invalid endpoint_url: ${String(urlStr).slice(0, 120)}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`endpoint_url must use http(s), got ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`endpoint_url host is not allowed: ${host || "(empty)"}`);
  }

  // Literal IP: check directly.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`endpoint_url points at a private address: ${host}`);
    return;
  }

  // Hostname: resolve and reject if any address is private (DNS-rebinding safe-ish).
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`could not resolve endpoint_url host: ${host}`);
  }
  if (addrs.length === 0) throw new Error(`endpoint_url host did not resolve: ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error(`endpoint_url resolves to a private address (${a.address})`);
    }
  }
}
