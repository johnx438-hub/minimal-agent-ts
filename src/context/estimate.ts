import { estimateTokens } from './budget.js';
import type { ChatMessage } from '../types.js';

/** Recent window protected from prune / pointer-compact (OpenCode-style). */
export const PROTECT_RECENT_TOKENS = 40_000;
export const PROTECT_USER_TURNS = 2;

export const NOTICE_PREFIX = '[context-notice]';
export const TASK_SUMMARY_PREFIX = '[Task ';

function estimateOne(msg: ChatMessage): number {
  return estimateTokens([msg]);
}

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