import { estimateTokens } from './budget.js';
import type { ChatMessage } from '../types.js';

/**
 * Scale: char/1.8 estimator vs legacy whitespace×1.3 on mixed CJK/Latin corpora.
 * Thresholds below were designed for the legacy estimator; multiply when porting.
 */
export const ESTIMATE_SCALE_VS_LEGACY = 3.5;

/**
 * Recent window protected from prune / pointer-compact (OpenCode-style).
 * Legacy design target: 40_000 under whitespace×1.3 → ~140k under char/1.8.
 */
export const PROTECT_RECENT_TOKENS = Math.round(40_000 * ESTIMATE_SCALE_VS_LEGACY);
export const PROTECT_USER_TURNS = 2;

export const NOTICE_PREFIX = '[context-notice]';
export const TASK_SUMMARY_PREFIX = '[Task ';

function estimateOne(msg: ChatMessage): number {
  return estimateTokens([msg]);
}

/** Optional protect window overrides (SPEC_CONTEXT_POLICY). Omit → module defaults. */
export interface ProtectWindowOptions {
  recentTokens?: number;
  userTurns?: number;
}

export function protectedIndices(
  messages: ChatMessage[],
  currentTurn: number,
  opts?: ProtectWindowOptions,
): Set<number> {
  const protectUserTurns = opts?.userTurns ?? PROTECT_USER_TURNS;
  const protectRecentTokens = opts?.recentTokens ?? PROTECT_RECENT_TOKENS;
  const protectedSet = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].turn === currentTurn) {
      protectedSet.add(i);
    }
  }

  let userCount = 0;
  for (let i = messages.length - 1; i >= 0 && userCount < protectUserTurns; i--) {
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
    if (recentTokens + t > protectRecentTokens) {
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
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (content.startsWith('error:')) return true;
  if (content.startsWith(NOTICE_PREFIX)) return true;
  if (content.startsWith(TASK_SUMMARY_PREFIX)) return true;
  return false;
}

/** Eligible for lightweight prune / savings estimate (shared by prune.ts). */
export function canPrune(msg: ChatMessage): boolean {
  if (msg.compacted_at) return false;
  if (msg.pointerized) return false;
  if (isImmune(msg)) return false;
  return msg.role === 'tool' || msg.role === 'assistant';
}

export function estimatePruneSavings(
  messages: ChatMessage[],
  currentTurn: number,
  protect?: ProtectWindowOptions,
): number {
  const protectedSet = protectedIndices(messages, currentTurn, protect);
  let savings = 0;
  for (let i = 0; i < messages.length; i++) {
    if (protectedSet.has(i)) continue;
    if (!canPrune(messages[i])) continue;
    savings += estimateOne(messages[i]);
  }
  return savings;
}