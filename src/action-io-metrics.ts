import type { AgentStepEvent } from './events.js';
import type { ActionFlushInfo } from './action-write-queue.js';
import { getActionWriteQueueDepth, isActionWriteQueueSync } from './action-write-queue.js';

export function isActionIoMetricsEnabled(): boolean {
  return process.env.ACTION_IO_METRICS === '1';
}

let activeTurn = 0;
let actionsSaved = 0;
let actionSaveMs = 0;
let turnActionFlushMs = 0;

export function beginTurnIo(turn: number): void {
  activeTurn = turn;
  actionsSaved = 0;
  actionSaveMs = 0;
  turnActionFlushMs = 0;
}

/** Sync mode: per-call disk write latency. Async mode: enqueue only (ms ignored). */
export function recordActionSave(durationMs: number): void {
  actionsSaved += 1;
  if (durationMs >= 0) {
    actionSaveMs += durationMs;
  }
}

/** Async mode: batch flush latency attributed to the active turn. */
export function recordActionFlush(info: ActionFlushInfo): void {
  if (info.count <= 0) return;
  turnActionFlushMs += info.flush_ms;
}

export function buildTurnIoEvent(turn: number): AgentStepEvent | null {
  if (actionsSaved === 0 && !isActionIoMetricsEnabled()) {
    return null;
  }
  const ioMs = isActionWriteQueueSync()
    ? actionSaveMs
    : turnActionFlushMs;
  return {
    type: 'turn_io',
    turn,
    actions_saved: actionsSaved,
    action_save_ms: Math.round(ioMs * 100) / 100,
    queue_depth: getActionWriteQueueDepth(),
  };
}

export function formatTurnIoSummary(event: Extract<AgentStepEvent, { type: 'turn_io' }>): string {
  const label = isActionWriteQueueSync() ? 'save' : 'flush';
  return `turn_io: ${event.actions_saved} action(s), ${event.action_save_ms}ms ${label}, queue=${event.queue_depth}`;
}

export function formatActionFlushSummary(event: {
  flush_ms: number;
  count: number;
  pending: number;
}): string {
  return `action_flush: ${event.count} file(s), ${event.flush_ms}ms, pending=${event.pending}`;
}

export function resetActionIoMetricsForTests(): void {
  activeTurn = 0;
  actionsSaved = 0;
  actionSaveMs = 0;
  turnActionFlushMs = 0;
}

export function getActiveTurnForTests(): number {
  return activeTurn;
}