/** Small inline stroke icons (no icon font / external assets: CSP allows only 'self'). */
import type { ReactNode } from 'react';

export type IconName = 'dashboard' | 'computer' | 'shield' | 'access' | 'building' | 'users' | 'online' | 'clock' | 'tag' | 'alert' | 'logout' | 'menu' | 'pulse';

const PATHS: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  computer: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  shield: <path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6l8-3z" />,
  access: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M16 7l3 3M14 9l2 2" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V5a2 2 0 012-2h8a2 2 0 012 2v16M16 9h2a2 2 0 012 2v10M3 21h18" />
      <path d="M8 7h4M8 11h4M8 15h4" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 010 7M18 14.5c1.9.6 3.1 2.6 3.5 5.5" />
    </>
  ),
  online: (
    <>
      <path d="M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0M2 9a14.5 14.5 0 0120 0" />
      <circle cx="12" cy="19.5" r="1" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  tag: (
    <>
      <path d="M3 12V4a1 1 0 011-1h8l9 9-9 9-9-9z" />
      <circle cx="8" cy="8" r="1.5" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3l10 18H2L12 3z" />
      <path d="M12 10v5M12 18v.01" />
    </>
  ),
  logout: <path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H3" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  pulse: <path d="M3 12h4l3-7 4 14 3-7h4" />,
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name]}
    </svg>
  );
}
