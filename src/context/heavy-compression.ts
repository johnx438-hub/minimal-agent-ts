import {
  buildEarlyContextSummary,
  estimateTokens,
  selectTaskLayers,
  shouldRunHeavyCompression,
  type BudgetConfig,
} from './budget.js';
import { assembleApiMessages } from './assemble.js';
import { NOTICE_PREFIX, TASK_SUMMARY_PREFIX } from './estimate.js';
import { compactPointerCardsUntilUnderBudget } from './pointer-compact.js';
import { applyPrune } from './prune.js';
import { formatSkillsInvokedForNotice } from '../session-skills.js';
import type {
  ChatMessage,
  SessionFile,
  SessionSkillInvoked,
  TaskSummaryDoc,
} from '../types.js';

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
      `Files: ${(task.files_touched ?? []).join(', ') || '(none)'}\n` +
      `Tools: ${(task.tools_used ?? []).join(', ') || '(none)'}\n` +
      `Work: ${task.current_work}`,
  }));
}

export function appendCompressionNotice(
  topics: string[],
  skillsInvoked?: SessionSkillInvoked[],
): ChatMessage {
  const topicStr = topics.length > 0 ? topics.join(', ') : '(see task summaries above)';
  let content =
    `${NOTICE_PREFIX} Earlier conversation was compressed. ` +
    `Large tool outputs appear as [action:…] cards — use recall_query(action_id=...) for details. ` +
    `Topics discussed: ${topicStr}.`;
  const skillsLine = formatSkillsInvokedForNotice(skillsInvoked);
  if (skillsLine) {
    content += ` ${skillsLine}`;
  }
  return {
    role: 'user',
    content,
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
  /** Skip pointer secondary compact when pipeline stage 2 already ran. */
  skipPointerCompact?: boolean;
}

/**
 * Full compression event when token budget exceeded.
 * Prune + inject task summaries + notice + replay user task (OpenCode-style).
 * Returns true if event was applied.
 */
export function runCompressionEvent(opts: CompressionEventOptions): boolean {
  const { messages, session, currentTurn, budget, userTask, skipPointerCompact } = opts;
  const visible = assembleApiMessages(messages);
  const isRepeat = hasCompressionNotice(messages);

  if (!shouldRunHeavyCompression(estimateTokens(visible), budget, isRepeat)) {
    return false;
  }

  applyPrune(messages, currentTurn);
  if (!skipPointerCompact) {
    compactPointerCardsUntilUnderBudget(messages, currentTurn, budget);
  }

  if (session && session.tasks.length > 0 && !hasTaskSummaryBlock(messages)) {
    const { mid, early } = selectTaskLayers(session.tasks, budget);
    const summaries: ChatMessage[] = [
      ...buildTaskSummaryMessages(mid),
      ...(early.length > 0 ? [buildEarlyContextSummary(early)] : []),
    ];
    if (summaries.length > 0) {
      const systemIdx = messages.findIndex((m) => m.role === 'system');
      const insertAt = systemIdx >= 0 ? systemIdx + 1 : 0;
      messages.splice(insertAt, 0, ...summaries);
    }
  }

  if (!isRepeat) {
    const topics = [...new Set(session?.tasks.flatMap((t) => t.tech_concepts) ?? [])];
    messages.push(appendCompressionNotice(topics, session?.skills_invoked));
    messages.push(replayLastUserTask(userTask));
  }

  return true;
}