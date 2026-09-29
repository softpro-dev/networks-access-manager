'use client';
import { useState } from 'react';
import { post } from '@/lib/api';
import { useAction } from '@/lib/queries';
import { deviceName } from '@/lib/format';
import type { Device, DeviceDetail } from '@/lib/types';
import { Button, ConfirmDialog } from './ui';

type Kind = 'approve' | 'reject' | 'revoke' | 're-enroll';

const COPY: Record<Kind, { title: string; label: string; body: (n: string) => string; destructive?: boolean; done: string }> = {
  approve: {
    title: 'Approve computer',
    label: 'Approve',
    body: (n) => `Approve "${n}"? The agent will claim its device credential on its next registration-status poll and start receiving its restrictions.`,
    done: 'Computer approved',
  },
  reject: {
    title: 'Reject computer',
    label: 'Reject',
    body: (n) => `Reject the enrollment request from "${n}"? The agent will not receive a credential.`,
    destructive: true,
    done: 'Computer rejected',
  },
  revoke: {
    title: 'Revoke computer',
    label: 'Revoke',
    body: (n) => `Revoke "${n}"? All of its credentials stop working immediately and it will no longer receive restrictions. This cannot be undone except by re-enrolling.`,
    destructive: true,
    done: 'Computer revoked',
  },
  're-enroll': {
    title: 'Re-enroll computer',
    label: 'Re-enroll',
    body: (n) => `Reset "${n}" to PENDING? Its credentials are revoked and the agent must register again with a new enrollment secret, then be approved again.`,
    destructive: true,
    done: 'Computer reset to PENDING',
  },
};

export function availableActions(d: Pick<Device, 'status'>): Kind[] {
  // A pre-added computer has no agent yet: nothing to approve, revoke or reset until it registers.
  if (d.status === 'PRE_REGISTERED') return [];
  const a: Kind[] = [];
  if (d.status === 'PENDING') a.push('approve', 'reject');
  if (d.status !== 'REVOKED') a.push('revoke');
  a.push('re-enroll');
  return a;
}

export function DeviceActions({ device, only, size }: { device: Device | DeviceDetail; only?: Kind[]; size?: 'sm' }) {
  const [pending, setPending] = useState<Kind | null>(null);
  const action = useAction((k: Kind) => post<DeviceDetail>(`/devices/${device.id}/${k}`), {
    success: (_r, k) => COPY[k].done,
    invalidate: [['devices'], ['device', device.id], ['analytics'], ['audit']],
    onSuccess: () => setPending(null),
  });
  const kinds = availableActions(device).filter((k) => !only || only.includes(k));
  const c = pending ? COPY[pending] : null;
  if (!kinds.length) return null;
  return (
    <>
      <div className="btn-row">
        {kinds.map((k) => (
          <Button
            key={k}
            size={size}
            variant={k === 'approve' ? 'primary' : k === 'revoke' ? 'danger' : 'secondary'}
            onClick={() => {
              action.reset();
              setPending(k);
            }}
          >
            {COPY[k].label}
          </Button>
        ))}
      </div>
      <ConfirmDialog
        open={!!pending}
        title={c?.title ?? ''}
        confirmLabel={c?.label}
        destructive={c?.destructive}
        busy={action.isPending}
        error={action.error}
        onClose={() => setPending(null)}
        onConfirm={() => pending && action.mutate(pending)}
      >
        <p>{c?.body(deviceName(device))}</p>
      </ConfirmDialog>
    </>
  );
}
