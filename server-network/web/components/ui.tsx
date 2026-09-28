'use client';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  variant = 'secondary',
  size,
  busy,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm'; busy?: boolean }) {
  const cls = ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && <span className="spinner spinner-inline" aria-hidden />}
      {children}
    </button>
  );
}

export type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'gray' | 'violet';

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  PENDING: 'amber',
  APPROVED: 'green',
  REJECTED: 'gray',
  REVOKED: 'red',
  ACTIVE: 'green',
  DISABLED: 'gray',
  DRAFT: 'blue',
  PUBLISHED: 'green',
  ARCHIVED: 'gray',
  APPLIED: 'green',
  HEALTHY: 'green',
  FAILED: 'red',
  VALIDATION_FAILED: 'red',
  ROLLED_BACK: 'amber',
  DEGRADED: 'amber',
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="muted">—</span>;
  return <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{status.replace(/_/g, ' ')}</Badge>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Renders the API error envelope (code, message, field details). */
export function ErrorBox({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const message = e ? e.message : error instanceof Error ? error.message : String(error);
  return (
    <div className="alert alert-error" role="alert">
      <div className="alert-title">
        {title ?? 'Request failed'}
        {e && <code className="alert-code">{e.code}</code>}
      </div>
      <div>{message}</div>
      {e && e.details.length > 0 && (
        <ul className="alert-details">
          {e.details.map((d, i) => (
            <li key={i}>
              {d.path && <code>{d.path}</code>} {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Alert({ tone = 'info', children, title }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode; title?: string }) {
  return (
    <div className={`alert alert-${tone}`}>
      {title && <div className="alert-title">{title}</div>}
      {children}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-header">
          {title && <h2 className="card-title">{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Field({ label, hint, children, error }: { label: string; hint?: ReactNode; children: ReactNode; error?: string | null }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

/** Modal built on the native <dialog> (focus trap, Esc, backdrop handled by the browser). */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <div className="modal-inner">
          <header className="modal-header">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </header>
          <div className="modal-body">{children}</div>
          {footer && <footer className="modal-footer">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Confirm',
  destructive,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} busy={busy} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        {children}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="pagination">
      <span className="muted">
        {from}–{to} of {total}
      </span>
      <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
        ‹ Prev
      </Button>
      <span className="muted">
        Page {page} / {pages}
      </span>
      <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
        Next ›
      </Button>
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: user can select the text */
        }
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

export function KeyValue({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <dt>{k}</dt>
          <dd>{v ?? <span className="muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="mono" title={title}>
      {children}
    </code>
  );
}

/** Sortable column header for client-side sorting of the current page. */
export function SortTh<K extends string>({
  label,
  k,
  sort,
  onSort,
}: {
  label: string;
  k: K;
  sort: { key: K; dir: 'asc' | 'desc' } | null;
  onSort: (k: K) => void;
}) {
  const active = sort?.key === k;
  return (
    <th aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="th-sort" onClick={() => onSort(k)}>
        {label}
        <span className="sort-ind" aria-hidden>
          {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}
