import { estimatePruneSavings, isImmune, protectedIndices } from './estimate.js';
import type { ChatMessage } from '../types.js';

function canPrune(msg: ChatMessage): boolean {
  if (msg.compacted_at) return false;
  if (msg.pointerized) return false;
  if (isImmune(msg)) return false;
  return msg.role === 'tool' || msg.role === 'assistant';
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
  const content = msg.content ?? '';
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
    const before = msg.content ?? '';
    releaseCompactedContent(msg);
    if ((msg.content ?? '') !== before) count++;
  }
  return count;
}

export { estimatePruneSavings } from './estimate.js';

export function shouldPrune(messages: ChatMessage[], currentTurn: number): boolean {
  return estimatePruneSavings(messages, currentTurn) >= PRUNE_MIN_SAVINGS;
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
export function applyPrune(messages: ChatMessage[], currentTurn: number): number {
  const protectedSet = protectedIndices(messages, currentTurn);
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
export function maybePrune(messages: ChatMessage[], currentTurn: number): number {
  if (!shouldPrune(messages, currentTurn)) {
    return 0;
  }
  return applyPrune(messages, currentTurn);
}