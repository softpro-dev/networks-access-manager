import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentEventHub, type AgentStream } from '../../src/services/agentEvents.js';

function fakeStream() {
  const sent: { event: string; data: any }[] = [];
  let closed = false;
  const s: AgentStream = {
    send: (event, data) => void sent.push({ event, data }),
    close: () => void (closed = true),
  };
  return { s, sent, isClosed: () => closed };
}

afterEach(() => vi.useRealTimers());

describe('AgentEventHub', () => {
  it('notifies only the streams of the changed organization, coalescing bursts into one event', () => {
    vi.useFakeTimers();
    const hub = new AgentEventHub(500);
    const a1 = fakeStream();
    const a2 = fakeStream();
    const b = fakeStream();
    hub.subscribe('org-a', a1.s);
    hub.subscribe('org-a', a2.s);
    hub.subscribe('org-b', b.s);

    hub.onAudit('org-a', 'POLICY_ASSIGNED');
    hub.onAudit('org-a', 'POLICY_ASSIGNED');
    hub.onAudit('org-a', 'POLICY_PUBLISHED');
    expect(a1.sent).toHaveLength(0); // debounced
    vi.advanceTimersByTime(500);

    for (const x of [a1, a2]) {
      expect(x.sent).toHaveLength(1);
      expect(x.sent[0]!.event).toBe('policy_changed');
      expect(x.sent[0]!.data.reasons.sort()).toEqual(['POLICY_ASSIGNED', 'POLICY_PUBLISHED']);
    }
    expect(b.sent).toHaveLength(0); // tenant isolation
  });

  it('ignores actions that cannot change a policy, and entries without an organization', () => {
    vi.useFakeTimers();
    const hub = new AgentEventHub(10);
    const a = fakeStream();
    hub.subscribe('org-a', a.s);
    hub.onAudit('org-a', 'LOGIN_SUCCESS');
    hub.onAudit('org-a', 'POLICY_DRAFT_UPDATED');
    hub.onAudit(null, 'POLICY_PUBLISHED');
    vi.advanceTimersByTime(50);
    expect(a.sent).toHaveLength(0);
  });

  it('closes the organization streams when its access token is rotated or cleared', () => {
    const hub = new AgentEventHub(10);
    const a = fakeStream();
    const b = fakeStream();
    hub.subscribe('org-a', a.s);
    hub.subscribe('org-b', b.s);
    hub.onAudit('org-a', 'ACCESS_TOKEN_SET');
    expect(a.isClosed()).toBe(true);
    expect(b.isClosed()).toBe(false);
    expect(hub.connections('org-a')).toBe(0);
  });

  it('unsubscribe and closeAll', () => {
    const hub = new AgentEventHub(10);
    const a = fakeStream();
    const b = fakeStream();
    const off = hub.subscribe('org-a', a.s);
    hub.subscribe('org-b', b.s);
    expect(hub.size).toBe(2);
    off();
    expect(hub.size).toBe(1);
    hub.closeAll();
    expect(b.isClosed()).toBe(true);
    expect(hub.size).toBe(0);
  });
});
