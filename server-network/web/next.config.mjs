// Next.js admin console. Fastify (../src) is the only backend: the browser talks to /api/* on this
// origin and Next proxies it to API_URL. No Next API routes / server actions hold business logic.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Read ONLY the port/API URL from ../.env (the server's secrets never enter the Next process env). */
function serverEnv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  try {
    const parsed = parseEnv(readFileSync(file, 'utf8'));
    return { PORT: parsed.PORT, API_URL: parsed.API_URL };
  } catch {
    return {};
  }
}

const fileEnv = serverEnv();
const apiUrl = (process.env.API_URL || fileEnv.API_URL || `http://localhost:${process.env.API_PORT || fileEnv.PORT || 3000}`).replace(/\/+$/, '');

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
  outputFileTracingRoot: root,
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    // /api/* responses are the Fastify API's own (strict CSP etc.) and are passed through untouched.
    return [{ source: '/((?!api/).*)', headers: securityHeaders }];
  },
};

export default nextConfig;
