import {
  estimateTokens,
  FIRST_HEAVY_COMPRESSION_RATIO,
  shouldRunHeavyCompression,
  usableContextTokens,
  type BudgetConfig,
} from './context/budget.js';
import { assembleApiMessages } from './context/assemble.js';
import { applyPrune, isImmune, protectedIndices } from './context/prune.js';
import type { ChatMessage, SessionFile, TaskSummaryDoc } from './types.js';

export {
  assembleApiMessages,
  filterApiSafeToolCalls,
  repairToolCallPairs,
} from './context/assemble.js';

export {
  PRUNE_MIN_SAVINGS,
  PROTECT_RECENT_TOKENS,
  PROTECT_USER_TURNS,
  releaseCompactedContent,
  releaseAllCompactedContent,
  estimatePruneSavings,
  shouldPrune,
  applyPrune,
  maybePrune,
} from './context/prune.js';

/** Max pointer cards downgraded per turn (secondary compact). */
export const MAX_POINTER_COMPACT_PER_TURN = 20;

const NOTICE_PREFIX = '[context-notice]';
const TASK_SUMMARY_PREFIX = '[Task ';

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
  msg.content = actionId
    ? `[compacted tool action_id=${actionId}]`
    : '[compacted tool]';
}

export function compactPointerCardsUntilUnderBudget(
  messages: ChatMessage[],
  currentTurn: number,
  budget: BudgetConfig,
): number {
  let compacted = 0;

  while (compacted < MAX_POINTER_COMPACT_PER_TURN) {
    const visible = assembleApiMessages(messages);
    const tokens = estimateTokens(visible);
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
): number {
  const visible = assembleApiMessages(messages);
  if (!shouldCompactPointerCards(estimateTokens(visible), budget)) {
    return 0;
  }
  return compactPointerCardsUntilUnderBudget(messages, currentTurn, budget);
}

export function hasCompressionNotice(messages: ChatMessage[]): boolean {
  return messages.some((m) => (m.content ?? '').startsWith(NOTICE_PREFIX));
}

export function hasTaskSummaryBlock(messages: ChatMessage[]): boolean {
  return messages.some((m) => (m.content ?? '').startsWith(TASK_SUMMARY_PREFIX));
}

export function buildTaskSummaryMessages(tasks: TaskSummaryDoc[]): ChatMessage[] {
  return tasks.map((task) => ({
    role: 'user' as const,
    content:
      `${TASK_SUMMARY_PREFIX}${task.task_id}] ${task.user_intent}\n` +
      `Files: ${task.files_touched.join(', ') || '(none)'}\n` +
      `Tools: ${task.tools_used.join(', ') || '(none)'}\n` +
      `Work: ${task.current_work}`,
  }));
}

export function appendCompressionNotice(topics: string[]): ChatMessage {
  const topicStr = topics.length > 0 ? topics.join(', ') : '(see task summaries above)';
  return {
    role: 'user',
    content:
      `${NOTICE_PREFIX} Earlier conversation was compressed. ` +
      `Large tool outputs appear as [action:…] cards — use recall_query(action_id=...) for details. ` +
      `Topics discussed: ${topicStr}.`,
  };
}

export function replayLastUserTask(userTask: ChatMessage): ChatMessage {
  return { ...userTask };
}

export interface CompressionEventOptions {
  messages: ChatMessage[];
  session?: SessionFile;
  currentTurn: number;
  budget: BudgetConfig;
  userTask: ChatMessage;
}

/**
 * Full compression event when token budget exceeded.
 * Prune + inject task summaries + notice + replay user task (OpenCode-style).
 * Returns true if event was applied.
 */
export function runCompressionEvent(opts: CompressionEventOptions): boolean {
  const { messages, session, currentTurn, budget, userTask } = opts;
  const visible = assembleApiMessages(messages);
  const isRepeat = hasCompressionNotice(messages);

  if (!shouldRunHeavyCompression(estimateTokens(visible), budget, isRepeat)) {
    return false;
  }

  applyPrune(messages, currentTurn);
  compactPointerCardsUntilUnderBudget(messages, currentTurn, budget);

  if (session && session.tasks.length > 0 && !hasTaskSummaryBlock(messages)) {
    const summaries = buildTaskSummaryMessages(session.tasks);
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    const insertAt = systemIdx >= 0 ? systemIdx + 1 : 0;
    messages.splice(insertAt, 0, ...summaries);
  }

  if (!isRepeat) {
    const topics = [...new Set(session?.tasks.flatMap((t) => t.tech_concepts) ?? [])];
    messages.push(appendCompressionNotice(topics));
    messages.push(replayLastUserTask(userTask));
  }

  return true;
}