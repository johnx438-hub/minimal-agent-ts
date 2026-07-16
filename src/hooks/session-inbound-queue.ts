/**
 * SPEC_JOB_SESSION_NOTIFY §6: per-session queue for system events → optional auto_run.
 */

import type { SystemEvent } from './system-event.js';

export const UNKNOWN_SESSION_ID = 'unknown';

export interface SessionInboundItem {
  event: SystemEvent;
  enqueued_at: number;
  auto_run: boolean;
}

function normalizeSessionId(sessionId: string): string {
  return sessionId.trim() || UNKNOWN_SESSION_ID;
}

export class SessionInboundQueue {
  private readonly bySession = new Map<string, SessionInboundItem[]>();

  enqueue(sessionId: string, item: SessionInboundItem): void {
    const id = normalizeSessionId(sessionId);
    const list = this.bySession.get(id) ?? [];
    list.push(item);
    this.bySession.set(id, list);
  }

  pendingCount(sessionId: string): number {
    return this.bySession.get(normalizeSessionId(sessionId))?.length ?? 0;
  }

  /**
   * Remove and return pending items (FIFO).
   * Only auto_run items are returned when onlyAutoRun is true (default).
   */
  drain(
    sessionId: string,
    opts?: { max?: number; onlyAutoRun?: boolean },
  ): SessionInboundItem[] {
    const id = normalizeSessionId(sessionId);
    const list = this.bySession.get(id) ?? [];
    if (list.length === 0) return [];

    const onlyAuto = opts?.onlyAutoRun !== false;
    const max = opts?.max ?? list.length;
    const taken: SessionInboundItem[] = [];
    const remain: SessionInboundItem[] = [];

    for (const item of list) {
      if (taken.length < max && (!onlyAuto || item.auto_run)) {
        taken.push(item);
      } else {
        remain.push(item);
      }
    }

    if (remain.length === 0) this.bySession.delete(id);
    else this.bySession.set(id, remain);

    return taken;
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.bySession.clear();
      return;
    }
    this.bySession.delete(normalizeSessionId(sessionId));
  }
}
