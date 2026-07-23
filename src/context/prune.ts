import {
  canPrune,
  estimatePruneSavings,
  protectedIndices,
  type ProtectWindowOptions,
} from './estimate.js';
import type { ChatMessage } from '../types.js';

/** Optional prune thresholds (SPEC_CONTEXT_POLICY). */
export interface PruneOptions {
  minSavings?: number;
  protect?: ProtectWindowOptions;
}

/**
 * Min estimated savings before prune (Phase 2c).
 * Legacy design target: 20_000 under whitespace×1.3 → ~70k under char/1.8
 * (see ESTIMATE_SCALE_VS_LEGACY in estimate.ts).
 */
export const PRUNE_MIN_SAVINGS = 70_000;

const COMPACTED_STUB_PREFIX = '[compacted';

/** Drop large in-memory bodies for API-pruned messages; cold storage retains full text. */
export function releaseCompactedContent(msg: ChatMessage): void {
  if (!msg.compacted_at) return;
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (content.startsWith(COMPACTED_STUB_PREFIX)) return;

  if (msg.role === 'tool' && msg.action_id) {
    msg.content = `[compacted tool action_id=${msg.action_id}]`;
  } else if (msg.role === 'tool') {
    msg.content = '[compacted tool]';
  } else if (msg.role === 'assistant') {
    msg.tool_calls = undefined;
    msg.content = '[compacted assistant]';
  } else {
    msg.content = '[compacted]';
  }
}

export function releaseAllCompactedContent(messages: ChatMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    const before = msg.content;
    releaseCompactedContent(msg);
    if (msg.content !== before) count++;
  }
  return count;
}

export { estimatePruneSavings } from './estimate.js';

export function shouldPrune(
  messages: ChatMessage[],
  currentTurn: number,
  opts?: PruneOptions,
): boolean {
  const min = opts?.minSavings ?? PRUNE_MIN_SAVINGS;
  return estimatePruneSavings(messages, currentTurn, opts?.protect) >= min;
}

function compactToolResponsesForAssistant(
  messages: ChatMessage[],
  assistantIndex: number,
  toolCallIds: Set<string>,
  now: number,
): number {
  if (toolCallIds.size === 0) return 0;
  const ids = toolCallIds;

  let count = 0;
  for (let j = assistantIndex + 1; j < messages.length && messages[j].role === 'tool'; j++) {
    const tid = messages[j].tool_call_id;
    if (!tid || !ids.has(tid)) break;
    if (messages[j].compacted_at) continue;
    messages[j].compacted_at = now;
    releaseCompactedContent(messages[j]);
    count++;
  }
  return count;
}

/** Mark eligible messages compacted_at (in-place). Returns count pruned. */
export function applyPrune(
  messages: ChatMessage[],
  currentTurn: number,
  opts?: PruneOptions,
): number {
  const protectedSet = protectedIndices(messages, currentTurn, opts?.protect);
  const now = Date.now();
  let count = 0;

  for (let i = 0; i < messages.length; i++) {
    if (protectedSet.has(i)) continue;
    if (messages[i].compacted_at) continue;
    if (!canPrune(messages[i])) continue;

    const cascadeToolCallIds =
      messages[i].role === 'assistant'
        ? new Set(messages[i].tool_calls?.map((tc) => tc.id) ?? [])
        : null;

    messages[i].compacted_at = now;
    releaseCompactedContent(messages[i]);
    count++;

    if (cascadeToolCallIds && cascadeToolCallIds.size > 0) {
      count += compactToolResponsesForAssistant(messages, i, cascadeToolCallIds, now);
    }
  }

  return count;
}

/**
 * Lightweight prune pass (no notice/replay) when savings exceed threshold.
 */
export function maybePrune(
  messages: ChatMessage[],
  currentTurn: number,
  opts?: PruneOptions,
): number {
  if (!shouldPrune(messages, currentTurn, opts)) {
    return 0;
  }
  return applyPrune(messages, currentTurn, opts);
}