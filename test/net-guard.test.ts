import { describe, it, expect } from "vitest";
import { isPrivateIp } from "@/lib/net-guard";

describe("isPrivateIp (SSRF guard)", () => {
  it("blocks loopback, private, link-local and metadata addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1", // multicast
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:127.0.0.1", // IPv4-mapped loopback
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("allows normal public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "104.16.0.1", "2606:4700:4700::1111"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("treats a non-IP string as unsafe", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
    expect(isPrivateIp("")).toBe(true);
  });

  it("172.32 is public (just outside the private range)", () => {
    expect(isPrivateIp("172.32.0.1")).toBe(false);
    expect(isPrivateIp("172.15.0.1")).toBe(false);
  });
});
