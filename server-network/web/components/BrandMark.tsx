import { useId } from 'react';

/**
 * The product mark: a white "N" on the brand gradient. Same geometry as app/icon.svg (favicon) and
 * os-apps/scripts/make_icons.py (desktop app icon) — change all three together.
 */
export function BrandMark({ size = 36, className }: { size?: number; className?: string }) {
  const id = `nam-grad-${useId().replace(/:/g, '')}`;
  return (
    <svg className={`brand-mark ${className ?? ''}`} width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset=".45" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id})`} />
      <path d="M10 23V9l12 14V9" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
