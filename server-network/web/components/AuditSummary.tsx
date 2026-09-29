'use client';
import Link from 'next/link';
import type { AuditEntry } from '@/lib/types';

const TARGET_LINKS: Record<string, string> = {
  Device: '/computers/',
  Policy: '/restrictions/',
  DeviceGroup: '/computers/groups/',
  Organization: '/organizations/',
};

/** One-line human summary of an audit entry (actor → target, with the most useful metadata). */
export function AuditSummary({ entry: e }: { entry: AuditEntry }) {
  const m = e.metadata ?? {};
  const label =
    (m.hostname as string | undefined) ??
    (m.title as string | undefined) ??
    (m.email as string | undefined) ??
    (m.policy_code as string | undefined) ??
    (m.name as string | undefined) ??
    (m.code as string | undefined) ??
    (e.target_id ? e.target_id.slice(0, 10) : null);
  const base = e.target_type ? TARGET_LINKS[e.target_type] : undefined;
  return (
    <span>
      <span className="muted">{e.actor_type.toLowerCase()}</span>
      {e.target_type && (
        <>
          {' → '}
          {e.target_type}{' '}
          {base && e.target_id && !['GROUP_DELETED', 'DEVICE_DELETED', 'ORGANIZATION_DELETED'].includes(e.action) ? <Link href={`${base}${e.target_id}`}>{label}</Link> : label}
        </>
      )}
      {typeof m.version === 'number' && <> v{m.version}</>}
    </span>
  );
}
