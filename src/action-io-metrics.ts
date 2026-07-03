import type { AgentStepEvent } from './events.js';
import { getActionWriteQueueDepth } from './action-write-queue.js';

export function isActionIoMetricsEnabled(): boolean {
  return process.env.ACTION_IO_METRICS === '1';
}

let activeTurn = 0;
let actionsSaved = 0;
let actionSaveMs = 0;

export function beginTurnIo(turn: number): void {
  activeTurn = turn;
  actionsSaved = 0;
  actionSaveMs = 0;
}

export function recordActionSave(durationMs: number): void {
  actionsSaved += 1;
  actionSaveMs += durationMs;
}

export function buildTurnIoEvent(turn: number): AgentStepEvent | null {
  if (actionsSaved === 0 && !isActionIoMetricsEnabled()) {
    return null;
  }
  return {
    type: 'turn_io',
    turn,
    actions_saved: actionsSaved,
    action_save_ms: Math.round(actionSaveMs * 100) / 100,
    queue_depth: getActionWriteQueueDepth(),
  };
}

export function formatTurnIoSummary(event: Extract<AgentStepEvent, { type: 'turn_io' }>): string {
  return `turn_io: ${event.actions_saved} action(s), ${event.action_save_ms}ms save, queue=${event.queue_depth}`;
}

export function formatActionFlushSummary(event: {
  flush_ms: number;
  count: number;
  pending: number;
}): string {
  return `action_flush: ${event.count} file(s), ${event.flush_ms}ms, pending=${event.pending}`;
}

export function formatIndexFlushSummary(event: {
  flush_ms: number;
  count: number;
  pending: number;
}): string {
  return `index_flush: ${event.count} indexed, ${event.flush_ms}ms, pending=${event.pending}`;
}

export function resetActionIoMetricsForTests(): void {
  activeTurn = 0;
  actionsSaved = 0;
  actionSaveMs = 0;
}

export function getActiveTurnForTests(): number {
  return activeTurn;
}