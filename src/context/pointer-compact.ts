import {
  estimateTokens,
  FIRST_HEAVY_COMPRESSION_RATIO,
  usableContextTokens,
  type BudgetConfig,
} from './budget.js';
import { assembleApiMessages } from './assemble.js';
import { isImmune, protectedIndices } from './estimate.js';
import type { ChatMessage } from '../types.js';

/** Max pointer cards downgraded per turn (secondary compact). */
export const MAX_POINTER_COMPACT_PER_TURN = 20;

function canCompactPointerCard(msg: ChatMessage): boolean {
  if (msg.role !== 'tool') return false;
  if (!msg.pointerized || !msg.action_id) return false;
  if (msg.compacted_at) return false;
  if (isImmune(msg)) return false;
  return true;
}

export function pointerCompactThreshold(budget: BudgetConfig): number {
  return usableContextTokens(budget) * FIRST_HEAVY_COMPRESSION_RATIO;
}

export function shouldCompactPointerCards(
  currentTokens: number,
  budget: BudgetConfig,
): boolean {
  return currentTokens > pointerCompactThreshold(budget);
}

function findOldestCompactablePointerIndex(
  messages: ChatMessage[],
  currentTurn: number,
): number {
  const protectedSet = protectedIndices(messages, currentTurn);
  for (let i = 0; i < messages.length; i++) {
    if (protectedSet.has(i)) continue;
    if (canCompactPointerCard(messages[i])) return i;
  }
  return -1;
}

/** Downgrade one pointer card to a compacted stub; ActionStore recall unchanged. */
export function applyPointerSecondaryCompact(msg: ChatMessage): void {
  const actionId = msg.action_id;
  msg.compacted_at = Date.now();
  const turnSuffix =
    msg.turn !== undefined && Number.isFinite(msg.turn) && msg.turn >= 0
      ? ` turn=${msg.turn}`
      : '';
  msg.content = actionId
    ? `[compacted tool action_id=${actionId}${turnSuffix}]`
    : `[compacted tool${turnSuffix}]`;
}

export function compactPointerCardsUntilUnderBudget(
  messages: ChatMessage[],
  currentTurn: number,
  budget: BudgetConfig,
  calibrator?: { apply(raw: number): number },
): number {
  let compacted = 0;

  while (compacted < MAX_POINTER_COMPACT_PER_TURN) {
    const visible = assembleApiMessages(messages);
    const raw = estimateTokens(visible);
    const tokens = calibrator ? calibrator.apply(raw) : raw;
    if (!shouldCompactPointerCards(tokens, budget)) {
      break;
    }

    const index = findOldestCompactablePointerIndex(messages, currentTurn);
    if (index < 0) {
      break;
    }

    applyPointerSecondaryCompact(messages[index]);
    compacted++;
  }

  return compacted;
}

/**
 * Secondary compact for pointer cards when context stays above 80% usable.
 * Fills the gap where pointerized messages are immune to normal prune.
 */
export function maybeCompactPointerCards(
  messages: ChatMessage[],
  currentTurn: number,
  budget: BudgetConfig,
  calibrator?: { apply(raw: number): number },
): number {
  const visible = assembleApiMessages(messages);
  const raw = estimateTokens(visible);
  const tokens = calibrator ? calibrator.apply(raw) : raw;
  if (!shouldCompactPointerCards(tokens, budget)) {
    return 0;
  }
  return compactPointerCardsUntilUnderBudget(messages, currentTurn, budget, calibrator);
}