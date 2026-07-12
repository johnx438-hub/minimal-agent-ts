import { estimateTokens } from './budget.js';
import type { ChatMessage } from '../types.js';

/** OpenCode-style prune thresholds (Phase 2c). */
export const PRUNE_MIN_SAVINGS = 20_000;
export const PROTECT_RECENT_TOKENS = 40_000;
export const PROTECT_USER_TURNS = 2;

const NOTICE_PREFIX = '[context-notice]';
const TASK_SUMMARY_PREFIX = '[Task ';
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

function estimateOne(msg: ChatMessage): number {
  return estimateTokens([msg]);
}

/** Protected message indices for prune and pointer-compact (exported for policy until L2-4). */
export function protectedIndices(messages: ChatMessage[], currentTurn: number): Set<number> {
  const protectedSet = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].turn === currentTurn) {
      protectedSet.add(i);
    }
  }

  let userCount = 0;
  for (let i = messages.length - 1; i >= 0 && userCount < PROTECT_USER_TURNS; i--) {
    if (messages[i].role === 'user') {
      protectedSet.add(i);
      userCount++;
    }
  }

  let recentTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateOne(messages[i]);
    if (protectedSet.has(i)) {
      recentTokens += t;
      continue;
    }
    if (recentTokens + t > PROTECT_RECENT_TOKENS) {
      break;
    }
    protectedSet.add(i);
    recentTokens += t;
  }

  return protectedSet;
}

/** Immune messages are skipped by prune and pointer secondary compact. */
export function isImmune(msg: ChatMessage): boolean {
  if (msg.role === 'system' || msg.role === 'user') return true;
  const content = msg.content ?? '';
  if (content.startsWith('error:')) return true;
  if (content.startsWith(NOTICE_PREFIX)) return true;
  if (content.startsWith(TASK_SUMMARY_PREFIX)) return true;
  return false;
}

function canPrune(msg: ChatMessage): boolean {
  if (msg.compacted_at) return false;
  if (msg.pointerized) return false;
  if (isImmune(msg)) return false;
  return msg.role === 'tool' || msg.role === 'assistant';
}

export function estimatePruneSavings(messages: ChatMessage[], currentTurn: number): number {
  const protectedSet = protectedIndices(messages, currentTurn);
  let savings = 0;
  for (let i = 0; i < messages.length; i++) {
    if (protectedSet.has(i)) continue;
    if (!canPrune(messages[i])) continue;
    savings += estimateOne(messages[i]);
  }
  return savings;
}

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