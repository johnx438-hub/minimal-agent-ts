import {
  estimateTokens,
  FIRST_HEAVY_COMPRESSION_RATIO,
  shouldRunHeavyCompression,
  usableContextTokens,
  type BudgetConfig,
} from './context-budget.js';
import { isToolArgsJsonValid } from './tools/tool-args.js';
import type { ChatMessage, SessionFile, TaskSummaryDoc, ToolCall } from './types.js';

/** OpenCode-style prune thresholds (Phase 2c). */
export const PRUNE_MIN_SAVINGS = 20_000;
export const PROTECT_RECENT_TOKENS = 40_000;
export const PROTECT_USER_TURNS = 2;

/** Max pointer cards downgraded per turn (secondary compact). */
export const MAX_POINTER_COMPACT_PER_TURN = 20;

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

/**
 * Messages marked compacted_at are omitted from LLM requests (OpenCode-style prune).
 * Repairs assistant/tool_call pairs so APIs never see orphan tool messages.
 */
export function assembleApiMessages(messages: ChatMessage[]): ChatMessage[] {
  const visible = messages.filter((m) => !m.compacted_at).map(stripInternalMetadata);
  return repairToolCallPairs(visible);
}

/**
 * Drop orphan tool messages and trim assistant tool_calls to matching responses.
 * OpenAI-compatible APIs require each tool message to follow an assistant tool_calls block.
 */
export function repairToolCallPairs(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role !== 'assistant' || !msg.tool_calls?.length) {
      if (msg.role === 'tool') {
        i++;
        continue;
      }
      result.push(msg);
      i++;
      continue;
    }

    const calls = filterApiSafeToolCalls(msg.tool_calls);
    if (calls.length === 0) {
      if (msg.content != null && msg.content !== '') {
        result.push({ role: 'assistant', content: msg.content });
      }
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        j++;
      }
      i = j;
      continue;
    }

    const callIds = new Set(calls.map((c) => c.id));
    const toolsById = new Map<string, ChatMessage>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') {
      const tid = messages[j].tool_call_id;
      if (tid && callIds.has(tid) && !toolsById.has(tid)) {
        toolsById.set(tid, messages[j]);
      }
      j++;
    }

    const validCalls = calls.filter((c) => toolsById.has(c.id));
    if (validCalls.length > 0) {
      result.push({
        role: 'assistant',
        content: msg.content,
        tool_calls: validCalls,
      });
      for (const call of validCalls) {
        const tool = toolsById.get(call.id);
        if (tool) {
          result.push({
            role: 'tool',
            tool_call_id: tool.tool_call_id,
            content: tool.content,
          });
        }
      }
    } else if (msg.content != null && msg.content !== '') {
      result.push({ role: 'assistant', content: msg.content });
    }

    i = j;
  }

  return result;
}

/** xAI and some providers reject assistant tool_calls whose arguments are not valid JSON. */
export function filterApiSafeToolCalls(calls: ToolCall[] | undefined): ToolCall[] {
  if (!calls?.length) return [];
  return calls.filter((c) => isToolArgsJsonValid(c.function.arguments));
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

/**
 * Lightweight prune pass (no notice/replay) when savings exceed threshold.
 */
export function maybePrune(messages: ChatMessage[], currentTurn: number): number {
  if (!shouldPrune(messages, currentTurn)) {
    return 0;
  }
  return applyPrune(messages, currentTurn);
}