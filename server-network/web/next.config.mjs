// Fastify hosts this console in the same process. It handles /api/* and forwards every
// non-API request to Next; no rewrite or second listener is needed.

/** Static security headers for every console response (the CSP itself is set per request in middleware.ts). */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,
  eslint: { ignoreDuringBuilds: true },
  async redirects() {
    // Old console URLs (Devices / Device groups / Policies) → Computers / Restrictions. Query strings are kept.
    return [
      { source: '/devices', destination: '/computers', permanent: false },
      { source: '/devices/:id', destination: '/computers/:id', permanent: false },
      { source: '/groups', destination: '/computers?tab=groups', permanent: false },
      { source: '/groups/:id', destination: '/computers/groups/:id', permanent: false },
      { source: '/policies', destination: '/restrictions', permanent: false },
      { source: '/policies/:id', destination: '/restrictions/:id', permanent: false },
    ];
  },
  async headers() {
    // /api/* responses are the Fastify API's own (strict CSP etc.) and are passed through untouched.
    return [{ source: '/((?!api/).*)', headers: securityHeaders }];
  },
};

export default nextConfig;
