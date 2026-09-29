'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useOrganizations } from '@/lib/queries';
import { deviceName } from '@/lib/format';
import { macError, normalizeMac } from '@/lib/mac';
import type { Device, DeviceDetail, DeviceGroup, List } from '@/lib/types';
import { useToast } from './toast';
import { Button, ConfirmDialog, CopyButton, Empty, ErrorBox, Field, Modal, Mono, Spinner } from './ui';

/** Everything that shows computers or groups (tables, dashboard, set access, effective rules). */
export const COMPUTER_KEYS = [['devices'], ['device'], ['groups'], ['group'], ['analytics'], ['assignments'], ['audit']];

export function useGroups(orgId: string, enabled = true) {
  return useQuery({
    queryKey: ['groups', { org: orgId }],
    queryFn: () => get<List<DeviceGroup>>('/device-groups', { organization_id: orgId || undefined }),
    enabled,
  });
}

/** Multi-select of the organization's groups, with inline creation of a new group. */
export function GroupSelect({ orgId, value, onChange }: { orgId: string; value: string[]; onChange: (ids: string[]) => void }) {
  const { isSuper } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const groups = useGroups(orgId, !!orgId);
  const [name, setName] = useState('');
  const create = useAction(() => post<DeviceGroup>('/device-groups', { name: name.trim(), ...(isSuper ? { organization_id: orgId } : {}) }), {
    onSuccess: async (g) => {
      await qc.invalidateQueries({ queryKey: ['groups'] });
      onChange([...value, g.id]);
      setName('');
      toast(`Group "${g.name}" created`, 'success');
    },
  });
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  if (!orgId) return <p className="muted small">Select the organization first.</p>;
  return (
    <div className="stack">
      {groups.isLoading ? (
        <Spinner />
      ) : groups.error ? (
        <ErrorBox error={groups.error} />
      ) : !groups.data?.items.length ? (
        <Empty>No groups yet — create one below.</Empty>
      ) : (
        <div className="picker picker-sm" role="group" aria-label="Groups">
          {groups.data.items.map((g) => (
            <label key={g.id} className="picker-row">
              <input type="checkbox" checked={value.includes(g.id)} onChange={() => toggle(g.id)} />
              <span className="strong grow">{g.name}</span>
              <span className="muted small">{g.member_count ?? 0} computers</span>
            </label>
          ))}
        </div>
      )}
      <div className="inline-create">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New group name"
          aria-label="New group name"
          maxLength={200}
          onKeyDown={(e) => {
            // Enter here must create the group, not submit the surrounding computer form.
            if (e.key === 'Enter') {
              e.preventDefault();
              if (name.trim()) create.mutate(undefined);
            }
          }}
        />
        <Button size="sm" busy={create.isPending} disabled={!name.trim()} onClick={() => create.mutate(undefined)}>
          Create group
        </Button>
      </div>
      <ErrorBox error={create.error} title="Could not create group" />
    </div>
  );
}

/** Add (pre-register by MAC) or edit a computer. */
export function ComputerFormDialog({ open, device, defaultOrgId, onClose }: { open: boolean; device?: Device | null; defaultOrgId: string; onClose: () => void }) {
  const { isSuper } = useAuth();
  const orgs = useOrganizations();
  const router = useRouter();
  const [f, setF] = useState({ organization_id: '', mac: '', title: '', serial: '', groups: [] as string[] });
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTouched(false);
    setF({
      organization_id: device?.organization.id ?? defaultOrgId,
      mac: device?.mac_address ?? '',
      title: device?.title ?? device?.display_name ?? '',
      serial: device?.serial_number ?? '',
      groups: device?.groups.map((g) => g.id) ?? [],
    });
  }, [open, device, defaultOrgId]);

  const editing = !!device;
  // Registered computers may have no MAC; pre-registered ones are identified by it.
  const macOptional = editing && device.status !== 'PRE_REGISTERED';
  const mac = normalizeMac(f.mac);
  const macErr = macOptional && !f.mac.trim() ? null : macError(f.mac);
  const valid = !!f.title.trim() && !macErr && (!isSuper || !!f.organization_id);

  const save = useAction(
    () => {
      const serial = f.serial.trim() || null;
      if (editing) {
        return patch<DeviceDetail>(`/devices/${device.id}`, {
          title: f.title.trim(),
          serial_number: serial,
          mac_address: f.mac.trim() ? mac : null,
          group_ids: f.groups,
        });
      }
      return post<DeviceDetail>('/devices', {
        ...(isSuper ? { organization_id: f.organization_id } : {}),
        mac_address: mac,
        title: f.title.trim(),
        ...(serial ? { serial_number: serial } : {}),
        group_ids: f.groups,
      });
    },
    {
      success: (d) => (editing ? `Saved ${deviceName(d)}` : `Added ${deviceName(d)} — it links when the agent on ${d.mac_address} registers`),
      invalidate: COMPUTER_KEYS,
      onSuccess: (d) => {
        onClose();
        if (!editing) router.push(`/computers/${d.id}`);
      },
    },
  );
  const [showMacHelp, setShowMacHelp] = useState(false);
  useEffect(() => {
    if (open) {
      save.reset();
      setShowMacHelp(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = () => {
    setTouched(true);
    if (valid) save.mutate(undefined);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={editing ? `Edit ${deviceName(device)}` : 'Add computer'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} disabled={touched && !valid} onClick={submit}>
            {editing ? 'Save' : 'Add computer'}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {!editing && (
          <p className="muted small">
            Pre-add a computer by its network adapter&apos;s MAC address. When the Windows agent on that machine registers, it is linked to this entry automatically — it still needs your approval before it
            receives restrictions.
          </p>
        )}
        {isSuper && !editing && (
          <Field label="Organization">
            <select value={f.organization_id} onChange={(e) => setF({ ...f, organization_id: e.target.value, groups: [] })}>
              <option value="">Select…</option>
              {orgs.data?.items.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.code} · {o.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="mac-help-toggle">
          <button type="button" className="link-button" aria-expanded={showMacHelp} aria-controls="mac-help" onClick={() => setShowMacHelp((v) => !v)}>
            {showMacHelp ? 'Hide MAC address help' : 'How do I find the MAC address?'}
          </button>
        </div>
        {showMacHelp && <MacAddressHelp />}
        <Field
          label={macOptional ? 'MAC address (optional)' : 'MAC address'}
          hint={mac && mac !== f.mac.trim() ? <>Will be saved as <Mono>{mac}</Mono></> : 'Any common format: AA:BB:CC:DD:EE:FF, aa-bb-cc-dd-ee-ff, aabb.ccdd.eeff'}
          error={(touched || f.mac.length >= 12) && macErr ? macErr : null}
        >
          <input
            value={f.mac}
            onChange={(e) => setF({ ...f, mac: e.target.value })}
            onBlur={() => {
              if (mac) setF((x) => ({ ...x, mac }));
            }}
            placeholder="AA:BB:CC:DD:EE:FF"
            className="mono"
            spellCheck={false}
            autoComplete="off"
            maxLength={32}
            autoFocus={!editing}
          />
        </Field>
        <div className="form-row">
          <Field label="Title" error={touched && !f.title.trim() ? 'Required' : null}>
            <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} placeholder="e.g. Lab 2 — PC 14" autoFocus={editing} />
          </Field>
          <Field label="Serial number (optional)">
            <input value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })} maxLength={100} autoComplete="off" />
          </Field>
        </div>
        <div className="field">
          <span className="field-label">Groups</span>
          <GroupSelect orgId={isSuper ? f.organization_id : (device?.organization.id ?? defaultOrgId)} value={f.groups} onChange={(groups) => setF((x) => ({ ...x, groups }))} />
        </div>
        <ErrorBox error={save.error} />
      </form>
    </Modal>
  );
}

/** Drop the deleted resource's detail query first (so an open detail page does not refetch a 404), then refresh the lists. */
export function useAfterDelete() {
  const qc = useQueryClient();
  return (detailKey: unknown[]) => {
    qc.removeQueries({ queryKey: detailKey, exact: true });
    for (const k of COMPUTER_KEYS) void qc.invalidateQueries({ queryKey: k });
  };
}

export function DeleteComputerDialog({ device, onClose, onDeleted }: { device: Device | null; onClose: () => void; onDeleted?: () => void }) {
  const afterDelete = useAfterDelete();
  const m = useAction(() => del(`/devices/${device!.id}`), {
    success: () => `Deleted ${device ? deviceName(device) : 'computer'}`,
    onSuccess: () => {
      const id = device!.id;
      onClose();
      onDeleted?.();
      afterDelete(['device', id]);
    },
  });
  useEffect(() => {
    if (device) m.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);
  return (
    <ConfirmDialog open={!!device} title="Delete computer" confirmLabel="Delete computer" destructive busy={m.isPending} error={m.error} onClose={onClose} onConfirm={() => m.mutate(undefined)}>
      <p>
        Permanently delete <strong>{device ? deviceName(device) : ''}</strong>
        {device?.mac_address && (
          <>
            {' '}
            (<Mono>{device.mac_address}</Mono>)
          </>
        )}
        ?
      </p>
      <p className="muted">
        Its credentials are revoked immediately and its group memberships and direct restriction assignments are removed. If its agent is still installed it stops receiving restrictions and would have to
        register (and be approved) again.
      </p>
    </ConfirmDialog>
  );
}

/** Commands an admin can run on the target machine to read its adapters' MAC addresses. */
const MAC_COMMANDS = [
  { os: 'Windows', where: 'Command Prompt or PowerShell', command: 'getmac /v /fo list' },
  { os: 'macOS', where: 'Terminal', command: 'networksetup -listallhardwareports' },
] as const;

function MacAddressHelp() {
  return (
    <div className="mac-help" id="mac-help">
      <div className="mac-help-title">Find the MAC address on the computer</div>
      {MAC_COMMANDS.map((c) => (
        <div className="mac-help-row" key={c.os}>
          <div className="mac-help-os">
            <strong>{c.os}</strong>
            <span className="muted small">{c.where}</span>
          </div>
          <code className="mac-help-cmd">{c.command}</code>
          <CopyButton value={c.command} />
        </div>
      ))}
      <p className="muted small">
        Use the physical Ethernet or Wi-Fi adapter (&quot;Physical Address&quot; on Windows, &quot;Ethernet Address&quot; on macOS), not virtual, VPN or Bluetooth adapters.
      </p>
    </div>
  );
}
