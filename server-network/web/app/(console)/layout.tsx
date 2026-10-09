'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useOrganizations } from '@/lib/queries';
import { Badge, Button, Spinner } from '@/components/ui';
import { OrgPicker } from '@/components/OrgPicker';
import { Icon, type IconName } from '@/components/Icons';
import { BrandMark } from '@/components/BrandMark';

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
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
    { href: '/', label: 'Dashboard', icon: 'dashboard' },
    { href: '/computers', label: 'Computers', icon: 'computer' },
    { href: '/restrictions', label: 'Restrictions', icon: 'shield' },
    { href: '/access', label: 'Set access', icon: 'access' },
    isSuper ? { href: '/organizations', label: 'Organizations', icon: 'building' } : { href: `/organizations/${user.organization_id}`, label: 'Organization', icon: 'building' },
    // Managing administrators is super-admin only (the API requires it for every change).
    ...(isSuper ? [{ href: '/users', label: 'Administrators', icon: 'users' as const }] : []),
  ];
  const initial = (user.name || user.email).trim().charAt(0).toUpperCase();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <div className="shell">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand">
          <BrandMark size={36} />
          <span className="brand-text">
            Network Access
            <span className="brand-sub">SoftProIt</span>
          </span>
        </div>
        <nav aria-label="Main" className="nav">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className={`nav-link ${isActive(n.href) ? 'active' : ''}`} aria-current={isActive(n.href) ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="live-dot" aria-hidden /> Policies served live
        </div>
      </aside>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} aria-hidden />}
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label="Open menu" onClick={() => setMenuOpen((v) => !v)}>
            <Icon name="menu" size={20} />
          </button>
          {isSuper && (
            <label className="topbar-org">
              <span className="muted small">Organization</span>
              <OrgPicker />
            </label>
          )}
          <div className="topbar-spacer" />
          <div className="whoami">
            <span className="avatar" aria-hidden>
              {initial}
            </span>
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
              <Icon name="logout" size={14} />
              Sign out
            </Button>
          </div>
        </header>
        <main className="content page-enter" key={pathname}>
          {children}
        </main>
      </div>
    </div>
  );
}
