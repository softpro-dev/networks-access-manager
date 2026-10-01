'use client';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { del, errorMessage, get, post } from '@/lib/api';
import { useOrgAssignments, useRestrictions } from '@/lib/queries';
import { useOrgScope } from '@/lib/orgScope';
import { deviceName, plural } from '@/lib/format';
import { KIND_INFO } from '@/lib/restrictions';
import type { Device, DeviceDetail, List, OrgAssignment, Page, Policy } from '@/lib/types';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorBox, Modal, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { useToast } from '@/components/toast';
import { OrgPicker } from '@/components/OrgPicker';
import { useGroups } from '@/components/ComputerDialogs';
import { EffectiveRules, KindBadge } from '@/components/EffectiveRules';

interface Target {
  organization?: boolean;
  group_ids?: string[];
  device_ids?: string[];
}

/** Everything whose content depends on assignments (merged rules, counts). */
const RESOLVE_KEYS = [['devices'], ['device'], ['analytics'], ['policy'], ['audit']];
const TEMP = 'tmp-';
let tempSeq = 0;

// ---------- draggable restriction card ----------
function CardBody({ policy, count }: { policy: Policy; count: number }) {
  return (
    <>
      <span className="r-card-grip" aria-hidden>
        ⠿
      </span>
      <span className="r-card-main">
        <span className="r-card-name">{policy.name}</span>
        <span className="r-card-meta">
          <KindBadge kind={policy.kind} />
          {!policy.active_version ? <Badge tone="amber">not published</Badge> : !policy.is_active ? <Badge tone="gray">inactive</Badge> : null}
          <span className="muted small">{plural(count, 'assignment')}</span>
        </span>
      </span>
    </>
  );
}

function RestrictionCard({ policy, count, onAssign }: { policy: Policy; count: number; onAssign: () => void }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: `policy:${policy.id}`, data: { policy } });
  const info = KIND_INFO[policy.kind];
  return (
    <div className={`r-card ${info.css} ${isDragging ? 'is-dragging' : ''}`}>
      <div ref={setNodeRef} className="r-card-handle" {...listeners} {...attributes} aria-label={`Drag ${policy.name} (${info.label}) onto a target`}>
        <CardBody policy={policy} count={count} />
      </div>
      <Button size="sm" variant="ghost" onClick={onAssign} aria-haspopup="dialog">
        Assign…
      </Button>
    </div>
  );
}

/** What follows the pointer while dragging (not itself draggable). */
function CardOverlay({ policy, count }: { policy: Policy; count: number }) {
  return (
    <div className={`r-card is-overlay ${KIND_INFO[policy.kind].css}`}>
      <div className="r-card-handle">
        <CardBody policy={policy} count={count} />
      </div>
    </div>
  );
}

// ---------- drop targets ----------
function DropZone({ id, className, children, label }: { id: string; className?: string; children: ReactNode; label: string }) {
  const { setNodeRef, isOver, active } = useDroppable({ id, data: { label } });
  return (
    <div ref={setNodeRef} className={`drop ${className ?? ''} ${active ? 'drop-ready' : ''} ${isOver ? 'drop-over' : ''}`}>
      {children}
    </div>
  );
}

type Inherited = { a: OrgAssignment; via: string };

function Chips({
  items,
  onRemove,
  inherited,
  onRemoveInherited,
}: {
  items: OrgAssignment[];
  onRemove: (a: OrgAssignment) => void;
  inherited?: Inherited[];
  /** Inherited chips come from an organization/group assignment: removing one removes it there (confirmed). */
  onRemoveInherited?: (x: Inherited) => void;
}) {
  if (!items.length && !inherited?.length) return <span className="muted small">No restrictions</span>;
  return (
    <span className="chips">
      {items.map((a) => (
        <span key={a.id} className={`r-chip ${KIND_INFO[a.policy.kind].css} ${a.id.startsWith(TEMP) ? 'pending' : ''} ${a.policy.is_active ? '' : 'inactive'}`} title={`${KIND_INFO[a.policy.kind].label}${a.policy.is_active ? '' : ' · inactive'}`}>
          {a.policy.name}
          <button type="button" aria-label={`Unassign ${a.policy.name}`} disabled={a.id.startsWith(TEMP)} onClick={() => onRemove(a)}>
            ×
          </button>
        </span>
      ))}
      {inherited?.map(({ a, via }) => (
        <span key={`${a.id}-inh`} className={`r-chip r-chip-inherited ${KIND_INFO[a.policy.kind].css}`} title={`Applies via ${via}`}>
          {a.policy.name} <span className="muted">· {via}</span>
          {onRemoveInherited && (
            <button type="button" aria-label={`Remove ${a.policy.name} from ${via}`} title={`Remove from ${via}`} disabled={a.id.startsWith(TEMP)} onClick={() => onRemoveInherited({ a, via })}>
              ×
            </button>
          )}
        </span>
      ))}
    </span>
  );
}

// ---------- keyboard / accessible alternative ----------
function AssignDialog({
  policy,
  groups,
  computers,
  selected,
  onClose,
  onAssign,
}: {
  policy: Policy | null;
  groups: { id: string; name: string; member_count?: number }[];
  computers: Device[];
  selected: Set<string>;
  onClose: () => void;
  onAssign: (p: Policy, t: Target) => void;
}) {
  const [org, setOrg] = useState(false);
  const [g, setG] = useState<Set<string>>(new Set());
  const [d, setD] = useState<Set<string>>(new Set());
  const [lastPolicy, setLastPolicy] = useState<string | null>(null);
  // Reset per opening; the current computer selection is pre-checked.
  if (policy && policy.id !== lastPolicy) {
    setLastPolicy(policy.id);
    setOrg(false);
    setG(new Set());
    setD(new Set(selected));
  }
  if (!policy && lastPolicy) setLastPolicy(null);
  const toggle = (s: Set<string>, set: (s: Set<string>) => void, id: string) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    set(n);
  };
  const any = org || g.size > 0 || d.size > 0;
  return (
    <Modal
      open={!!policy}
      onClose={onClose}
      wide
      title={`Assign ${policy?.name ?? ''}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!any}
            onClick={() => {
              if (policy) onAssign(policy, { organization: org, group_ids: [...g], device_ids: [...d] });
              onClose();
            }}
          >
            Assign
          </Button>
        </>
      }
    >
      <div className="stack">
        <label className="check">
          <input type="checkbox" checked={org} onChange={(e) => setOrg(e.target.checked)} />
          <span>
            <strong>Whole organization</strong>
            <span className="field-hint">Every computer, including ones added later.</span>
          </span>
        </label>
        <fieldset className="plain-fieldset">
          <legend className="field-label">Groups</legend>
          {!groups.length ? (
            <span className="muted small">No groups.</span>
          ) : (
            <div className="picker picker-sm">
              {groups.map((x) => (
                <label key={x.id} className="picker-row">
                  <input type="checkbox" checked={g.has(x.id)} onChange={() => toggle(g, setG, x.id)} />
                  <span className="strong grow">{x.name}</span>
                  <span className="muted small">{plural(x.member_count ?? 0, 'computer')}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <fieldset className="plain-fieldset">
          <legend className="field-label">Computers</legend>
          {!computers.length ? (
            <span className="muted small">No computers.</span>
          ) : (
            <div className="picker picker-sm">
              {computers.map((x) => (
                <label key={x.id} className="picker-row">
                  <input type="checkbox" checked={d.has(x.id)} onChange={() => toggle(d, setD, x.id)} />
                  <span className="strong grow">{deviceName(x)}</span>
                  <StatusBadge status={x.status} />
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </div>
    </Modal>
  );
}

// ---------- page ----------
function AccessBoard({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const restrictions = useRestrictions(orgId);
  const groups = useGroups(orgId);
  const assignments = useOrgAssignments(orgId);
  const [q, setQ] = useState('');
  const devicesQuery = { organization_id: orgId, q: q.trim() || undefined, page_size: 200 };
  const devices = useQuery({
    queryKey: ['devices', { access: true, ...devicesQuery }],
    queryFn: () => get<Page<Device>>('/devices', devicesQuery),
    placeholderData: keepPreviousData,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<Policy | null>(null);
  const [assigning, setAssigning] = useState<Policy | null>(null);
  const [removingInherited, setRemovingInherited] = useState<Inherited | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const previewQ = useQuery({ queryKey: ['device', preview], queryFn: () => get<DeviceDetail>(`/devices/${preview}`), enabled: !!preview });

  const key = ['assignments', { org: orgId }];
  const items = assignments.data?.items ?? [];
  const computers = devices.data?.items ?? [];
  const groupList = groups.data?.items ?? [];
  const groupName = useMemo(() => new Map(groupList.map((g) => [g.id, g.name])), [groupList]);
  const deviceById = useMemo(() => new Map(computers.map((d) => [d.id, d])), [computers]);
  const count = (policyId: string) => items.filter((a) => a.policy_id === policyId).length;
  const orgItems = items.filter((a) => a.scope === 'ORGANIZATION');
  const groupItems = (id: string) => items.filter((a) => a.scope === 'GROUP' && a.target_group_id === id);
  const deviceItems = (id: string) => items.filter((a) => a.scope === 'DEVICE' && a.target_device_id === id);
  const inheritedFor = (d: Device) => [
    ...orgItems.map((a) => ({ a, via: 'organization' })),
    ...d.groups.flatMap((g) => groupItems(g.id).map((a) => ({ a, via: g.name }))),
  ];

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    for (const k of RESOLVE_KEYS) void qc.invalidateQueries({ queryKey: k });
  };

  /** Optimistic bulk assign: temporary chips appear at once and are removed again if the API refuses. */
  async function assign(policy: Policy, t: Target) {
    const current = qc.getQueryData<List<OrgAssignment>>(key)?.items ?? [];
    const has = (scope: OrgAssignment['scope'], g?: string, d?: string) =>
      current.some((a) => a.policy_id === policy.id && a.scope === scope && (a.target_group_id ?? undefined) === g && (a.target_device_id ?? undefined) === d);
    const org = !!t.organization && !has('ORGANIZATION');
    const groupIds = [...new Set(t.group_ids ?? [])].filter((g) => !has('GROUP', g));
    const deviceIds = [...new Set(t.device_ids ?? [])].filter((d) => !has('DEVICE', undefined, d));
    const n = (org ? 1 : 0) + groupIds.length + deviceIds.length;
    if (!n) {
      toast(`${policy.name} is already assigned there`, 'info');
      return;
    }
    const base = { policy_id: policy.id, organization_id: orgId, priority: 0, synced: false, created_by_id: null, created_at: new Date().toISOString(), policy: { id: policy.id, code: policy.code, name: policy.name, kind: policy.kind, is_active: policy.is_active } };
    const temps: OrgAssignment[] = [
      ...(org ? [{ ...base, id: `${TEMP}${++tempSeq}`, scope: 'ORGANIZATION' as const, target_group_id: null, target_device_id: null, target_name: null }] : []),
      ...groupIds.map((g) => ({ ...base, id: `${TEMP}${++tempSeq}`, scope: 'GROUP' as const, target_group_id: g, target_device_id: null, target_name: groupName.get(g) ?? null })),
      ...deviceIds.map((d) => ({ ...base, id: `${TEMP}${++tempSeq}`, scope: 'DEVICE' as const, target_group_id: null, target_device_id: d, target_name: deviceById.get(d) ? deviceName(deviceById.get(d)!) : null })),
    ];
    const tempIds = new Set(temps.map((x) => x.id));
    await qc.cancelQueries({ queryKey: key });
    qc.setQueryData<List<OrgAssignment>>(key, (old) => ({ items: [...(old?.items ?? []), ...temps] }));
    const where = [org ? 'the whole organization' : null, groupIds.length ? plural(groupIds.length, 'group') : null, deviceIds.length ? plural(deviceIds.length, 'computer') : null].filter(Boolean).join(', ');
    try {
      await post('/assignments/bulk', { policy_id: policy.id, organization: org, group_ids: groupIds, device_ids: deviceIds });
      toast(`Assigned ${policy.name} to ${where}`, 'success');
    } catch (e) {
      qc.setQueryData<List<OrgAssignment>>(key, (old) => ({ items: (old?.items ?? []).filter((x) => !tempIds.has(x.id)) }));
      toast(`Could not assign ${policy.name}: ${errorMessage(e)}`, 'error');
    } finally {
      refresh();
    }
  }

  async function unassign(a: OrgAssignment) {
    await qc.cancelQueries({ queryKey: key });
    qc.setQueryData<List<OrgAssignment>>(key, (old) => ({ items: (old?.items ?? []).filter((x) => x.id !== a.id) }));
    const where = a.scope === 'ORGANIZATION' ? 'the organization' : (a.target_name ?? 'target');
    try {
      await del(`/policies/${a.policy_id}/assignments/${a.id}`);
      toast(`Removed ${a.policy.name} from ${where}`, 'success');
    } catch (e) {
      qc.setQueryData<List<OrgAssignment>>(key, (old) => ({ items: [...(old?.items ?? []).filter((x) => x.id !== a.id), a] }));
      toast(`Could not unassign ${a.policy.name}: ${errorMessage(e)}`, 'error');
    } finally {
      refresh();
    }
  }

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );
  const policyOf = (id: string | number) => restrictions.data?.items.find((p) => `policy:${p.id}` === id);
  const targetLabel = (id: string | number | undefined) => {
    const s = String(id ?? '');
    if (s === 'org') return 'Whole organization';
    if (s === 'selected') return `${plural(selected.size, 'selected computer')}`;
    if (s.startsWith('group:')) return `group ${groupName.get(s.slice(6)) ?? ''}`;
    if (s.startsWith('device:')) {
      const d = deviceById.get(s.slice(7));
      return d ? `computer ${deviceName(d)}` : 'computer';
    }
    return 'nothing';
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up restriction ${policyOf(active.id)?.name ?? ''}. Use the arrow keys to move over a target and press space to assign.`,
    onDragOver: ({ active, over }) => `${policyOf(active.id)?.name ?? ''} is over ${targetLabel(over?.id)}.`,
    onDragEnd: ({ active, over }) => (over ? `${policyOf(active.id)?.name ?? ''} dropped on ${targetLabel(over.id)}.` : 'Dropped outside a target; nothing assigned.'),
    onDragCancel: () => 'Drag cancelled; nothing assigned.',
  };

  const onDragStart = (e: DragStartEvent) => setDragging((e.active.data.current?.policy as Policy | undefined) ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const policy = e.active.data.current?.policy as Policy | undefined;
    const over = e.over ? String(e.over.id) : null;
    if (!policy || !over) return;
    if (over === 'org') void assign(policy, { organization: true });
    else if (over === 'selected') void assign(policy, { device_ids: [...selected] });
    else if (over.startsWith('group:')) void assign(policy, { group_ids: [over.slice(6)] });
    else if (over.startsWith('device:')) void assign(policy, { device_ids: [over.slice(7)] });
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allSelected = computers.length > 0 && computers.every((d) => selected.has(d.id));

  const loading = restrictions.isLoading || groups.isLoading || assignments.isLoading;
  const error = restrictions.error ?? groups.error ?? assignments.error;
  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  const policies = restrictions.data?.items ?? [];

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)} accessibility={{ announcements }}>
      <div className={`access-layout ${preview ? 'with-preview' : ''}`}>
        <aside className="access-palette" aria-label="Restrictions">
          <h2 className="section-title">Restrictions</h2>
          <p className="muted small">Drag a card onto a target, or use Assign….</p>
          {!policies.length ? (
            <Empty>
              No restrictions yet. <Link href="/restrictions/new">Create one</Link>.
            </Empty>
          ) : (
            policies.map((p) => <RestrictionCard key={p.id} policy={p} count={count(p.id)} onAssign={() => setAssigning(p)} />)
          )}
        </aside>

        <div className="access-targets">
          <DropZone id="org" className="drop-org" label="Whole organization">
            <div className="drop-head">
              <strong>Whole organization</strong>
              <span className="muted small">every computer, including ones added later</span>
            </div>
            <Chips items={orgItems} onRemove={unassign} />
          </DropZone>

          <section>
            <h2 className="section-title">
              Groups <Link href="/computers?tab=groups" className="small">manage</Link>
            </h2>
            {!groupList.length ? (
              <Empty>
                No groups yet. <Link href="/computers?tab=groups">Create groups</Link> to assign restrictions to many computers at once.
              </Empty>
            ) : (
              <div className="drop-grid">
                {groupList.map((g) => (
                  <DropZone key={g.id} id={`group:${g.id}`} label={g.name}>
                    <div className="drop-head">
                      <Link href={`/computers/groups/${g.id}`} className="strong">
                        {g.name}
                      </Link>
                      <span className="muted small">{plural(g.member_count ?? 0, 'computer')}</span>
                    </div>
                    <Chips items={groupItems(g.id)} onRemove={unassign} />
                  </DropZone>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="section-title">Computers</h2>
            <div className="toolbar">
              <input type="search" className="grow" placeholder="Filter computers…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter computers" />
              <label className="check check-inline">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(computers.map((d) => d.id)))}
                  disabled={!computers.length}
                />
                <span>Select all shown</span>
              </label>
            </div>
            {selected.size > 0 && (
              <DropZone id="selected" className="drop-selected" label="Selected computers">
                <div className="drop-head">
                  <strong>{plural(selected.size, 'selected computer')}</strong>
                  <span className="muted small">drop a restriction here to assign it to all of them</span>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                </div>
              </DropZone>
            )}
            {devices.error && <ErrorBox error={devices.error} />}
            {devices.isLoading ? (
              <Spinner />
            ) : !computers.length ? (
              <Empty>{q ? 'No computers match.' : 'No computers yet.'}</Empty>
            ) : (
              <div className="drop-list">
                {computers.map((d) => (
                  <DropZone key={d.id} id={`device:${d.id}`} className={`drop-row ${selected.has(d.id) ? 'is-selected' : ''} ${preview === d.id ? 'is-previewed' : ''}`} label={deviceName(d)}>
                    <label className="drop-row-select">
                      <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} aria-label={`Select ${deviceName(d)}`} />
                    </label>
                    <div className="drop-row-main">
                      <div className="drop-head">
                        <Link href={`/computers/${d.id}`} className="strong">
                          {deviceName(d)}
                        </Link>
                        <StatusBadge status={d.status} />
                        {d.groups.map((g) => (
                          <span key={g.id} className="chip">
                            {g.name}
                          </span>
                        ))}
                      </div>
                      <Chips items={deviceItems(d.id)} onRemove={unassign} inherited={inheritedFor(d)} onRemoveInherited={setRemovingInherited} />
                    </div>
                    <Button size="sm" variant="ghost" aria-pressed={preview === d.id} onClick={() => setPreview(preview === d.id ? null : d.id)}>
                      {preview === d.id ? 'Hide rules' : 'Rules'}
                    </Button>
                  </DropZone>
                ))}
              </div>
            )}
            {devices.data && devices.data.total > computers.length && (
              <p className="muted small">
                Showing {computers.length} of {devices.data.total}; filter to find others.
              </p>
            )}
          </section>
        </div>

        {preview && (
          <aside className="access-preview" aria-label="Effective rules preview">
            <Card
              title={previewQ.data ? `Effective rules · ${deviceName(previewQ.data)}` : 'Effective rules'}
              actions={
                <button type="button" className="icon-btn" aria-label="Close preview" onClick={() => setPreview(null)}>
                  ×
                </button>
              }
            >
              {previewQ.isLoading ? <Spinner /> : previewQ.error ? <ErrorBox error={previewQ.error} /> : <EffectiveRules effective={previewQ.data?.effective_policy ?? null} compact />}
              {previewQ.isFetching && !previewQ.isLoading && <span className="muted small">Updating…</span>}
            </Card>
          </aside>
        )}
      </div>
      <DragOverlay dropAnimation={null}>{dragging ? <CardOverlay policy={dragging} count={count(dragging.id)} /> : null}</DragOverlay>
      <AssignDialog policy={assigning} groups={groupList} computers={computers} selected={selected} onClose={() => setAssigning(null)} onAssign={(p, t) => void assign(p, t)} />
      <ConfirmDialog
        open={!!removingInherited}
        title={removingInherited ? `Remove ${removingInherited.a.policy.name}?` : ''}
        confirmLabel={removingInherited?.a.scope === 'ORGANIZATION' ? 'Remove from organization' : 'Remove from group'}
        destructive
        onClose={() => setRemovingInherited(null)}
        onConfirm={() => {
          if (removingInherited) void unassign(removingInherited.a);
          setRemovingInherited(null);
        }}
      >
        {removingInherited && (
          <p>
            <strong>{removingInherited.a.policy.name}</strong> is assigned to{' '}
            {removingInherited.a.scope === 'ORGANIZATION' ? (
              <>
                the <strong>whole organization</strong>. Removing it takes it off{' '}
                <strong>all {plural(devices.data?.total ?? computers.length, 'computer')}</strong>, not only this one.
              </>
            ) : (
              <>
                the group <strong>{removingInherited.via}</strong>. Removing it takes it off{' '}
                <strong>{plural(groupList.find((g) => g.id === removingInherited.a.target_group_id)?.member_count ?? 0, 'computer')}</strong> in that group.
              </>
            )}{' '}
            To restrict only some computers, assign it to those groups or computers instead.
          </p>
        )}
      </ConfirmDialog>
    </DndContext>
  );
}

export default function SetAccessPage() {
  const { orgId, isSuper, org } = useOrgScope({ required: true });
  return (
    <>
      <PageHeader
        title="Set access"
        subtitle={
          <>
            Drag a restriction onto the whole organization, a group or computers. Everything that reaches a computer is <strong>merged</strong>: any Allow Only list switches it to allow-only mode; black
            lists and redirections add up.{isSuper && org ? ` · ${org.code} · ${org.name}` : ''}
          </>
        }
      />
      {isSuper && !orgId ? (
        <Card title="Choose an organization">
          <p className="muted">Assignments always belong to one organization.</p>
          <OrgPicker allowAll={false} />
        </Card>
      ) : (
        <AccessBoard key={orgId} orgId={orgId} />
      )}
    </>
  );
}
