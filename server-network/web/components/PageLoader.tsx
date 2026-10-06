'use client';
// Global top progress bar: visible while the page first loads and while navigating between pages
// (sidebar or any other in-app link). The App Router has no "navigation started" event, so a click
// on an internal link starts it and the URL actually changing (pathname/search) finishes it.
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

type Phase = 'loading' | 'done' | 'idle';

/** Safety net: never leave the bar running (e.g. a link that ends up not navigating). */
const MAX_LOADING_MS = 10_000;
/** How long the finished (100%) bar stays before fading out. */
const FINISH_MS = 350;

function currentLocation() {
  return window.location.pathname + window.location.search;
}

function PageLoaderInner() {
  const pathname = usePathname();
  const search = useSearchParams();
  // Starts in "loading" on the server and on first client render (same markup), so the bar is
  // already running while the app hydrates; the mount effect below completes it.
  const [phase, setPhase] = useState<Phase>('loading');
  const [cycle, setCycle] = useState(0);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  const finish = () => {
    clearTimers();
    setPhase((p) => (p === 'loading' ? 'done' : p));
    timers.current.push(window.setTimeout(() => setPhase((p) => (p === 'done' ? 'idle' : p)), FINISH_MS));
  };

  const start = () => {
    clearTimers();
    setCycle((c) => c + 1); // restart the CSS animation
    setPhase('loading');
    timers.current.push(window.setTimeout(finish, MAX_LOADING_MS));
  };

  // Initial page load done, and every completed navigation (the URL changed).
  useEffect(() => {
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, search]);

  // Start on clicks that will navigate inside the app.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!(a instanceof HTMLAnchorElement) || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname + url.search === currentLocation()) return; // same page (or only #hash)
      start();
    };
    const onPopState = () => start(); // back/forward
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'idle') return null;
  return (
    <div className={`page-loader page-loader-${phase}`} role="progressbar" aria-label="Loading page" aria-busy={phase === 'loading'}>
      <div key={cycle} className="page-loader-bar" />
    </div>
  );
}

export function PageLoader() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <PageLoaderInner />
    </Suspense>
  );
}
