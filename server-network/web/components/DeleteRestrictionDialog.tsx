'use client';
import { del } from '@/lib/api';
import { plural } from '@/lib/format';
import { useAction } from '@/lib/queries';
import { Alert, ConfirmDialog, Mono } from './ui';

export interface DeletableRestriction {
  id: string;
  code: string;
  name: string;
}

/** Everything a deleted restriction can appear in: lists, assignments and resolved computer rules. */
const DELETE_KEYS = [['policies'], ['policy'], ['assignments'], ['devices'], ['device'], ['analytics'], ['audit']];

/**
 * Permanently delete a restriction (DELETE /policies/:id): all its versions and every assignment of it
 * (organization, groups, computers) are removed; the audit log keeps the deletion.
 */
export function DeleteRestrictionDialog({
  restriction,
  assignmentCount,
  onClose,
  onDeleted,
}: {
  restriction: DeletableRestriction | null;
  /** shown in the warning when known */
  assignmentCount?: number;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const m = useAction(() => del<{ code: string; assignments: number; versions: number }>(`/policies/${restriction!.id}`), {
    success: (r) => `Deleted ${r.code} and ${plural(r.assignments, 'assignment')}`,
    invalidate: DELETE_KEYS,
    onSuccess: () => {
      onClose();
      onDeleted?.();
    },
  });
  return (
    <ConfirmDialog
      open={!!restriction}
      title={`Delete ${restriction?.name ?? ''}`}
      confirmLabel="Delete restriction"
      destructive
      busy={m.isPending}
      error={m.error}
      onClose={() => {
        m.reset();
        onClose();
      }}
      onConfirm={() => m.mutate(undefined)}
    >
      <Alert tone="error" title="This cannot be undone">
        Deletes <strong>{restriction?.name}</strong> (<Mono>{restriction?.code}</Mono>) with all its versions
        {assignmentCount === undefined ? ' and every assignment of it' : assignmentCount > 0 ? ` and its ${plural(assignmentCount, 'assignment')}` : ''} (whole
        organization, groups and computers). Computers stop receiving it on their next policy update. The audit log keeps a record.
      </Alert>
    </ConfirmDialog>
  );
}
