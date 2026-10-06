'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useOrganizations } from '@/lib/queries';
import { Badge, Button, Spinner } from '@/components/ui';
import { OrgPicker } from '@/components/OrgPicker';

interface NavItem {
  href: string;
  label: string;
}

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  const { session, user, isSuper, logout, endReason } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const orgs = useOrganizations();

  useEffect(() => {
    // After an explicit sign-out start fresh; after expiry come back to the same page.
    if (session === null) router.replace(`/login${endReason !== 'logout' && pathname && pathname !== '/' ? `?next=${encodeURIComponent(pathname)}` : ''}`);
  }, [session, router, pathname, endReason]);
  useEffect(() => setMenuOpen(false), [pathname]);

  if (!session || !user) return <Spinner label={session === null ? 'Redirecting to sign-in…' : 'Loading…'} />;

  const ownOrg = !isSuper ? orgs.data?.items.find((o) => o.id === user.organization_id) : undefined;
  const nav: NavItem[] = [
    { href: '/', label: 'Dashboard' },
    { href: '/computers', label: 'Computers' },
    { href: '/restrictions', label: 'Restrictions' },
    { href: '/access', label: 'Set access' },
    isSuper ? { href: '/organizations', label: 'Organizations' } : { href: `/organizations/${user.organization_id}`, label: 'Organization' },
    // Managing administrators is super-admin only (the API requires it for every change).
    ...(isSuper ? [{ href: '/users', label: 'Administrators' }] : []),
  ];
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <div className="shell">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            N
          </span>
          <span>Network Access</span>
        </div>
        <nav aria-label="Main">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className={`nav-link ${isActive(n.href) ? 'active' : ''}`} aria-current={isActive(n.href) ? 'page' : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
      </aside>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} aria-hidden />}
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label="Open menu" onClick={() => setMenuOpen((v) => !v)}>
            ☰
          </button>
          {isSuper && (
            <label className="topbar-org">
              <span className="muted small">Organization</span>
              <OrgPicker />
            </label>
          )}
          <div className="topbar-spacer" />
          <div className="whoami">
            <div className="whoami-text">
              <span className="whoami-email">{user.name ? `${user.name} · ${user.email}` : user.email}</span>
              <span className="whoami-meta">
                <Badge tone={isSuper ? 'violet' : 'blue'}>{isSuper ? 'Super admin' : 'Organization admin'}</Badge>
                {!isSuper && (
                  <span className="muted" title={ownOrg?.name}>
                    {ownOrg ? `${ownOrg.code} · ${ownOrg.name}` : user.organization_code}
                  </span>
                )}
              </span>
            </div>
            <Button size="sm" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
