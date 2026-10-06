/**
 * Live "policy changed" notifications for org-token services (contract §4.3).
 *
 * Services keep one Server-Sent Events stream open (`GET /api/agent/events`). When an admin changes
 * anything that can alter what a computer of the organization is served, every open stream of that
 * organization receives `event: policy_changed`, and the service immediately re-fetches
 * `/api/agent/org-policy` the normal way (ETag, validation, Synced column unchanged). The event
 * carries no policy data, so a lost event only delays the update until the next poll.
 *
 * Single-process, in-memory: with several API instances behind a load balancer, a shared bus
 * (e.g. Redis pub/sub) would have to fan `notifyOrg` out to all of them.
 */
// Type-only: audit.ts imports this module, so no runtime import back (circular ESM init).
import type { AuditActionName } from './audit.js';

/** Audit actions after which the organization's services should re-fetch their policy. */
const NOTIFY_ACTIONS = new Set<AuditActionName>([
  'POLICY_PUBLISHED',
  'POLICY_ROLLED_BACK',
  'POLICY_ACTIVATED',
  'POLICY_DEACTIVATED',
  'POLICY_DELETED',
  'POLICY_ASSIGNED',
  'POLICY_UNASSIGNED',
  'GROUP_DELETED',
  'GROUP_MEMBERS_CHANGED',
  'DEVICE_CREATED',
  'DEVICE_UPDATED',
  'DEVICE_DELETED',
  'DEVICE_SYNC_RESET',
  'ORGANIZATION_UPDATED',
]);
/** Audit actions that invalidate the streams' credentials: close them (reconnects then get 401). */
const DISCONNECT_ACTIONS = new Set<AuditActionName>(['ACCESS_TOKEN_SET', 'ACCESS_TOKEN_CLEARED', 'ORGANIZATION_DELETED']);

/** Changes arriving within this window (bulk assign, publish + assign, a transaction committing) become one event. */
export const NOTIFY_DEBOUNCE_MS = 750;

export interface AgentStream {
  send(event: string, data: unknown): void;
  close(): void;
}

export class AgentEventHub {
  private readonly byOrg = new Map<string, Set<AgentStream>>();
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; reasons: Set<string> }>();

  constructor(private readonly debounceMs = NOTIFY_DEBOUNCE_MS) {}

  get size(): number {
    let n = 0;
    for (const s of this.byOrg.values()) n += s.size;
    return n;
  }

  connections(orgId: string): number {
    return this.byOrg.get(orgId)?.size ?? 0;
  }

  /** Registers a stream; returns the function that unregisters it. */
  subscribe(orgId: string, stream: AgentStream): () => void {
    let set = this.byOrg.get(orgId);
    if (!set) this.byOrg.set(orgId, (set = new Set()));
    set.add(stream);
    return () => {
      const s = this.byOrg.get(orgId);
      if (!s) return;
      s.delete(stream);
      if (s.size === 0) this.byOrg.delete(orgId);
    };
  }

  /** Tells every connected service of the organization to re-fetch (debounced per organization). */
  notifyOrg(orgId: string, reason: string): void {
    const p = this.pending.get(orgId);
    if (p) {
      p.reasons.add(reason);
      return;
    }
    const reasons = new Set([reason]);
    const timer = setTimeout(() => {
      this.pending.delete(orgId);
      this.flush(orgId, [...reasons]);
    }, this.debounceMs);
    timer.unref?.();
    this.pending.set(orgId, { timer, reasons });
  }

  private flush(orgId: string, reasons: string[]): void {
    const set = this.byOrg.get(orgId);
    if (!set) return;
    const data = { reasons, at: new Date().toISOString() };
    for (const s of [...set]) {
      try {
        s.send('policy_changed', data);
      } catch {
        s.close();
      }
    }
  }

  disconnectOrg(orgId: string): void {
    const set = this.byOrg.get(orgId);
    if (!set) return;
    for (const s of [...set]) s.close();
    this.byOrg.delete(orgId);
  }

  /** Hook called for every audit entry (services/audit.ts): routes it to notify / disconnect. */
  onAudit(orgId: string | null | undefined, action: AuditActionName): void {
    if (!orgId) return;
    if (DISCONNECT_ACTIONS.has(action)) this.disconnectOrg(orgId);
    else if (NOTIFY_ACTIONS.has(action)) this.notifyOrg(orgId, action);
  }

  /** Server shutdown: end every stream (hijacked responses would otherwise keep `close()` waiting). */
  closeAll(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const orgId of [...this.byOrg.keys()]) this.disconnectOrg(orgId);
  }
}

/** Process-wide hub: every admin change is audited, so `writeAudit` feeds it and no call site can be missed. */
export const agentEvents = new AgentEventHub();
