import { estimateTokens, shouldCompress, type BudgetConfig } from './context-budget.js';
import type { ChatMessage, SessionFile, TaskSummaryDoc } from './types.js';

/** OpenCode-style prune thresholds (Phase 2c). */
export const PRUNE_MIN_SAVINGS = 20_000;
export const PROTECT_RECENT_TOKENS = 40_000;
export const PROTECT_USER_TURNS = 2;

const NOTICE_PREFIX = '[context-notice]';
const TASK_SUMMARY_PREFIX = '[Task ';
const COMPACTED_STUB_PREFIX = '[compacted';

/** Drop large in-memory bodies for API-pruned messages; cold storage retains full text. */
export function releaseCompactedContent(msg: ChatMessage): void {
  if (!msg.compacted_at || msg.pointerized) return;
  const content = msg.content ?? '';
  if (content.startsWith(COMPACTED_STUB_PREFIX)) return;

  if (msg.role === 'tool' && msg.action_id) {
    msg.content = `[compacted tool action_id=${msg.action_id}]`;
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

/**
 * Messages marked compacted_at are omitted from LLM requests (OpenCode-style prune).
 */
export function assembleApiMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => !m.compacted_at).map(stripInternalMetadata);
}

/** Remove fields not accepted by OpenAI-compatible chat APIs. */
function stripInternalMetadata(msg: ChatMessage): ChatMessage {
  const {
    action_id: _a,
    pointerized: _p,
    compacted_at: _c,
    turn: _t,
    ...apiMsg
  } = msg;
  return apiMsg;
}

function estimateOne(msg: ChatMessage): number {
  return estimateTokens([msg]);
}

function protectedIndices(messages: ChatMessage[], currentTurn: number): Set<number> {
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

function isImmune(msg: ChatMessage): boolean {
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

/** Mark eligible messages compacted_at (in-place). Returns count pruned. */
export function applyPrune(messages: ChatMessage[], currentTurn: number): number {
  const protectedSet = protectedIndices(messages, currentTurn);
  const now = Date.now();
  let count = 0;

  for (let i = 0; i < messages.length; i++) {
    if (protectedSet.has(i)) continue;
    if (!canPrune(messages[i])) continue;
    messages[i].compacted_at = now;
    releaseCompactedContent(messages[i]);
    count++;
  }

  return count;
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

  if (!shouldCompress(estimateTokens(visible), budget)) {
    return false;
  }

  applyPrune(messages, currentTurn);

  if (session && session.tasks.length > 0 && !hasTaskSummaryBlock(messages)) {
    const summaries = buildTaskSummaryMessages(session.tasks);
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    const insertAt = systemIdx >= 0 ? systemIdx + 1 : 0;
    messages.splice(insertAt, 0, ...summaries);
  }

  if (!hasCompressionNotice(messages)) {
    const topics = [...new Set(session?.tasks.flatMap((t) => t.tech_concepts) ?? [])];
    messages.push(appendCompressionNotice(topics));
  }

  messages.push(replayLastUserTask(userTask));
  return true;
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