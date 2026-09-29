'use client';
import { useOrgScope } from '@/lib/orgScope';

/** Organization selector for super admins (renders nothing for organization admins). */
export function OrgPicker({ allowAll = true, className }: { allowAll?: boolean; className?: string }) {
  const { isSuper, orgId, setOrgId, orgs } = useOrgScope();
  if (!isSuper) return null;
  return (
    <select className={className} value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label="Organization">
      <option value="">{allowAll ? 'All organizations' : 'Select an organization…'}</option>
      {orgs.map((o) => (
        <option key={o.id} value={o.id}>
          {o.code} · {o.name}
        </option>
      ))}
    </select>
  );
}
