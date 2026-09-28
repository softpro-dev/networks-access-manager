import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Network Access Manager', template: '%s · Network Access Manager' },
  description: 'Admin console for the Network Access Management server',
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, colorScheme: 'light dark' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading the request headers opts every page into dynamic rendering, so each response gets the
  // per-request CSP nonce generated in middleware.ts (Next applies it to its own inline scripts).
  await headers();
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
