import {
  estimateTokens,
  FIRST_HEAVY_COMPRESSION_RATIO,
  usableContextTokens,
  type BudgetConfig,
} from './budget.js';
import { assembleApiMessages } from './assemble.js';
import {
  isImmune,
  protectedIndices,
  type ProtectWindowOptions,
} from './estimate.js';
import type { ChatMessage } from '../types.js';

/** Max pointer cards downgraded per turn (secondary compact). */
export const MAX_POINTER_COMPACT_PER_TURN = 20;

export interface PointerCompactOptions {
  maxPerTurn?: number;
  protect?: ProtectWindowOptions;
  calibrator?: { apply(raw: number): number };
}

function canCompactPointerCard(msg: ChatMessage): boolean {
  if (msg.role !== 'tool') return false;
  if (!msg.pointerized || !msg.action_id) return false;
  if (msg.compacted_at) return false;
  if (isImmune(msg)) return false;
  return true;
}

export function pointerCompactThreshold(budget: BudgetConfig): number {
  const ratio = budget.first_heavy_ratio ?? FIRST_HEAVY_COMPRESSION_RATIO;
  return usableContextTokens(budget) * ratio;
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
  protect?: ProtectWindowOptions,
): number {
  const protectedSet = protectedIndices(messages, currentTurn, protect);
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
  calibratorOrOpts?: { apply(raw: number): number } | PointerCompactOptions,
): number {
  const opts: PointerCompactOptions =
    calibratorOrOpts && typeof (calibratorOrOpts as { apply?: unknown }).apply === 'function'
      ? { calibrator: calibratorOrOpts as { apply(raw: number): number } }
      : ((calibratorOrOpts as PointerCompactOptions | undefined) ?? {});
  const calibrator = opts.calibrator;
  const maxPerTurn = opts.maxPerTurn ?? MAX_POINTER_COMPACT_PER_TURN;
  let compacted = 0;

  while (compacted < maxPerTurn) {
    const visible = assembleApiMessages(messages);
    const raw = estimateTokens(visible);
    const tokens = calibrator ? calibrator.apply(raw) : raw;
    if (!shouldCompactPointerCards(tokens, budget)) {
      break;
    }

    const index = findOldestCompactablePointerIndex(
      messages,
      currentTurn,
      opts.protect,
    );
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
  calibratorOrOpts?: { apply(raw: number): number } | PointerCompactOptions,
): number {
  const opts: PointerCompactOptions =
    calibratorOrOpts && typeof (calibratorOrOpts as { apply?: unknown }).apply === 'function'
      ? { calibrator: calibratorOrOpts as { apply(raw: number): number } }
      : ((calibratorOrOpts as PointerCompactOptions | undefined) ?? {});
  const calibrator = opts.calibrator;
  const visible = assembleApiMessages(messages);
  const raw = estimateTokens(visible);
  const tokens = calibrator ? calibrator.apply(raw) : raw;
  if (!shouldCompactPointerCards(tokens, budget)) {
    return 0;
  }
  return compactPointerCardsUntilUnderBudget(messages, currentTurn, budget, opts);
}