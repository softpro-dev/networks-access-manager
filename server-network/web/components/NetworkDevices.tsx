'use client';
// "Add My PC" and "Add from network" (bulk) — both use the LAN scan the desktop app passed in
// ?connected_devices= (lib/connectedDevices). Each computer is created with POST /devices, so the
// server's validation, tenant scoping and MAC_IN_USE check apply exactly as for "Add computer".
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post } from '@/lib/api';
import { useConnectedDevices, type ConnectedDevice } from '@/lib/connectedDevices';
import { absTime } from '@/lib/format';
import { useAction } from '@/lib/queries';
import type { DeviceDetail, Device, Page } from '@/lib/types';
import { useToast } from './toast';
import { Alert, Button, Empty, Modal, Mono } from './ui';
import { COMPUTER_KEYS } from './ComputerDialogs';

const NOT_FROM_APP = 'Open the console from the SoftProIt Network Admin desktop app to detect MAC addresses.';

export function myComputerTitle(d: ConnectedDevice): string {
  return `My Computer (${d.username || d.hostname || d.ip})`;
}

function createDevice(orgId: string | null, mac: string, title: string) {
  return post<DeviceDetail>('/devices', { ...(orgId ? { organization_id: orgId } : {}), mac_address: mac, title });
}

/**
 * One click, no dialog: adds the PC running the desktop app as "My Computer (<USERNAME>)".
 * `orgId` is required for a SUPER_ADMIN (the organization the Computers page is scoped to).
 */
export function AddMyPcButton({ isSuper, orgId }: { isSuper: boolean; orgId: string }) {
  const snapshot = useConnectedDevices();
  const me = snapshot?.devices.find((d) => d.self);
  const needsOrg = isSuper && !orgId;
  const m = useAction(() => createDevice(isSuper ? orgId : null, me!.mac, myComputerTitle(me!)), {
    success: (d) => `Added ${d.title ?? d.display_name ?? 'this computer'} (${d.mac_address})`,
    invalidate: COMPUTER_KEYS,
    toastErrors: true,
  });
  const title = !me ? NOT_FROM_APP : needsOrg ? 'Choose an organization first' : `Add this computer (${me.mac}, ${me.ip}) as "${myComputerTitle(me)}"`;
  return (
    <Button busy={m.isPending} disabled={!me || needsOrg} title={title} onClick={() => m.mutate(undefined)}>
      Add My PC
    </Button>
  );
}

interface Row extends ConnectedDevice {
  title: string;
  selected: boolean;
  existing: boolean;
  result?: 'added' | 'exists' | string;
}

/** Bulk entry: pick computers from the scanned LAN, edit their titles, add them in one go. */
export function BulkAddFromNetworkDialog({ open, isSuper, orgId, onClose }: { open: boolean; isSuper: boolean; orgId: string; onClose: () => void }) {
  const snapshot = useConnectedDevices();
  const toast = useToast();
  const qc = useQueryClient();
  const scope = isSuper ? orgId : null;
  // Mark computers this organization already has (first 200; anything else is caught by MAC_IN_USE).
  const known = useQuery({
    queryKey: ['devices', { organization_id: scope ?? undefined, page_size: 200, purpose: 'bulk-add' }],
    queryFn: () => get<Page<Device>>('/devices', { organization_id: scope ?? undefined, page_size: 200 }),
    enabled: open && (!isSuper || !!orgId),
  });
  const knownMacs = useMemo(() => new Set((known.data?.items ?? []).map((d) => d.mac_address).filter(Boolean)), [known.data]);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(
      (snapshot?.devices ?? []).map((d) => {
        const existing = knownMacs.has(d.mac);
        return { ...d, title: d.self ? myComputerTitle(d) : `PC ${d.ip}`, selected: !existing, existing };
      }),
    );
  }, [open, snapshot, knownMacs]);

  const chosen = rows.filter((r) => r.selected && !r.result);
  const allSelectable = rows.filter((r) => !r.existing && !r.result);
  const set = (mac: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.mac === mac ? { ...r, ...patch } : r)));

  const submit = async () => {
    setBusy(true);
    let added = 0;
    let exists = 0;
    let failed = 0;
    for (const r of chosen) {
      const title = r.title.trim() || `PC ${r.ip}`;
      try {
        await createDevice(scope, r.mac, title);
        added++;
        set(r.mac, { result: 'added', selected: false });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'MAC_IN_USE') {
          exists++;
          set(r.mac, { result: 'exists', selected: false, existing: true });
        } else {
          failed++;
          set(r.mac, { result: e instanceof Error ? e.message : 'Failed' });
        }
      }
    }
    await Promise.all(COMPUTER_KEYS.map((k) => qc.invalidateQueries({ queryKey: k })));
    setBusy(false);
    const parts = [`${added} added`, exists ? `${exists} already existed` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(', ');
    toast(`Bulk add: ${parts}`, failed ? 'error' : 'success');
    if (!failed) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      wide
      title="Add computers from network"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button variant="primary" busy={busy} disabled={!chosen.length || (isSuper && !orgId)} onClick={submit}>
            Add {chosen.length || ''} computer{chosen.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {!snapshot ? (
        <Alert tone="info">{NOT_FROM_APP}</Alert>
      ) : isSuper && !orgId ? (
        <Alert tone="info">Choose an organization at the top of the page first.</Alert>
      ) : !rows.length ? (
        <Empty>No devices were found on the local network.</Empty>
      ) : (
        <div className="stack">
          <p className="muted small">
            {rows.length} device{rows.length === 1 ? '' : 's'} found by the desktop app on {absTime(snapshot.captured_at)}. Reopen the app to rescan.
            Routers, phones and printers appear too — select only computers.
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={!!allSelectable.length && allSelectable.every((r) => r.selected)}
                      onChange={(e) => setRows((rs) => rs.map((r) => (r.existing || r.result ? r : { ...r, selected: e.target.checked })))}
                      disabled={busy}
                    />
                  </th>
                  <th>IP</th>
                  <th>MAC address</th>
                  <th>Title</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.mac}>
                    <td>
                      <input type="checkbox" aria-label={`Select ${r.ip}`} checked={r.selected} disabled={busy || r.existing || !!r.result} onChange={(e) => set(r.mac, { selected: e.target.checked })} />
                    </td>
                    <td className="nowrap">
                      <Mono>{r.ip}</Mono>
                      {r.self && <span className="muted small"> (this PC)</span>}
                    </td>
                    <td className="nowrap">
                      <Mono>{r.mac}</Mono>
                    </td>
                    <td>
                      <input value={r.title} maxLength={200} disabled={busy || r.existing || !!r.result} onChange={(e) => set(r.mac, { title: e.target.value })} aria-label={`Title for ${r.ip}`} />
                    </td>
                    <td className="nowrap small">
                      {r.result === 'added' ? '✓ Added' : r.existing ? 'Already added' : r.result ? <span className="field-error">{r.result}</span> : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
