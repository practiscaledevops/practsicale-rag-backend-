/** @type {import('next').NextConfig} */

// Baseline browser hardening for the dashboard. The public API is consumed by
// servers (spokes), so these headers cost nothing there; for the dashboard they
// stop clickjacking, MIME sniffing and referrer leakage, and pin HTTPS.
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig = {
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }];
  },
};
export default nextConfig;
