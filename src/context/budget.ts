import type { ChatMessage, SessionFile, TaskSummaryDoc } from '../types.js';

/** Budget configuration for context window management. */
export interface BudgetConfig {
  total: number;           // Total model context limit (e.g., 262_000)
  
  // Percentage-based allocation
  system_pct: number;      // System prompt
  current_pct: number;     // Current task description
  recent_pct: number;      // Recent full action_blocks
  mid_pct: number;         // Mid-term task summaries
  early_pct: number;       // Early session summary
  
  // Absolute caps (prevent excessive growth on large-context models)
  recent_max_tokens: number;   // Max tokens for recent layer
  mid_max_summaries: number;   // Max number of task summaries in mid layer
}

/** Default budget when model unknown and MAX_CONTEXT_TOKENS unset. */
export const DEFAULT_CONTEXT_TOKENS = 200_000;

/** Default budget configuration. */
export const DEFAULT_BUDGET: BudgetConfig = {
  total: DEFAULT_CONTEXT_TOKENS,
  system_pct: 0.05,        // 5%
  current_pct: 0.1,        // 10%
  recent_pct: 0.4,         // 40%
  mid_pct: 0.35,           // 35%
  early_pct: 0.1,          // 10%
  recent_max_tokens: 80_000,
  mid_max_summaries: 20,
};

/** Model context limits mapping (no API probe; see api-docs.deepseek.com). */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // DeepSeek V4 — official CONTEXT LENGTH 1M (flash + pro)
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek/deepseek-v4-flash': 1_000_000,
  'deepseek/deepseek-v4-pro': 1_000_000,
  'deepseek/deepseek-chat': 1_000_000,
  'deepseek/deepseek-reasoner': 1_000_000,
  
  // Qwen series
  'qwen3.6-27b': 262_000,
  'qwen3.6-14b': 128_000,
  'qwen-turbo': 1_000_000,
  
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
};

/**
 * Get max context tokens for a model.
 * Priority: env override > mapping table > safe default
 */
export function getMaxContextTokens(model: string): number {
  // 1. Environment variable override (highest priority)
  const envLimit = process.env.MAX_CONTEXT_TOKENS?.trim();
  if (envLimit) {
    const parsed = Number(envLimit);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  
  // 2. Mapping table lookup
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (model.includes(key) || key.includes(model)) {
      return limit;
    }
  }
  
  // 3. Safe default fallback
  return DEFAULT_BUDGET.total;
}

/**
 * Create budget config for a given model.
 */
export function createBudgetConfig(model: string): BudgetConfig {
  const total = getMaxContextTokens(model);
  const recentCap = Math.floor(total * DEFAULT_BUDGET.recent_pct);
  return {
    ...DEFAULT_BUDGET,
    total,
    recent_max_tokens: Math.max(DEFAULT_BUDGET.recent_max_tokens, recentCap),
  };
}

/** Average characters per token (mixed CJK + Latin; ~10% error). */
export const CHARS_PER_TOKEN = 1.8;

/** Estimate tokens from raw text (CJK-safe; whitespace-agnostic). */
export function estimateTextTokens(text: string): number {
  const chars = text.trim().length;
  return chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : 0;
}

/** Estimate token count for messages plus role/tool_call overhead. */
export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTextTokens(msg.content ?? '');
    total += msg.role === 'tool' ? 5 : 2;
    if (msg.tool_calls) {
      total += msg.tool_calls.length * 10;
    }
  }
  return total;
}

/** Estimate token count for a task summary document. */
export function estimateSummaryTokens(summary: TaskSummaryDoc): number {
  const text = [
    summary.user_intent,
    ...summary.user_messages,
    ...(summary.files_touched ?? []),
    ...(summary.tech_concepts ?? []),
    ...(summary.tools_used ?? []),
    ...(summary.pending_tasks ?? []),
    summary.current_work,
  ].join(' ');

  return estimateTextTokens(text);
}

/** First heavy compression: 80% of usable context. */
export const FIRST_HEAVY_COMPRESSION_RATIO = 0.8;

/** Subsequent heavy compression: 90% of usable context (hysteresis). */
export const REPEAT_HEAVY_COMPRESSION_RATIO = 0.9;

export function usableContextTokens(budget: BudgetConfig): number {
  return budget.total * (1 - budget.system_pct);
}

export function heavyCompressionThreshold(
  budget: BudgetConfig,
  isRepeat: boolean,
): number {
  const ratio = isRepeat ? REPEAT_HEAVY_COMPRESSION_RATIO : FIRST_HEAVY_COMPRESSION_RATIO;
  return usableContextTokens(budget) * ratio;
}

/**
 * Whether a full compression event (prune + summaries + notice) should run.
 * First event at 80% usable; repeats at 90% usable.
 */
export function shouldRunHeavyCompression(
  currentTokens: number,
  budget: BudgetConfig,
  isRepeat: boolean,
): boolean {
  return currentTokens > heavyCompressionThreshold(budget, isRepeat);
}

/** @deprecated Alias for first heavy compression check (session resume, docs). */
export function shouldCompress(currentTokens: number, budget: BudgetConfig): boolean {
  return shouldRunHeavyCompression(currentTokens, budget, false);
}

export interface TaskLayers {
  recent: TaskSummaryDoc[];
  mid: TaskSummaryDoc[];
  early: TaskSummaryDoc[];
}

/** Split session tasks into recent / mid / early layers (most-recent-first selection). */
export function selectTaskLayers(tasks: TaskSummaryDoc[], budget: BudgetConfig): TaskLayers {
  const allTasks = [...tasks].reverse();
  const recentBudget = Math.min(
    budget.total * budget.recent_pct,
    budget.recent_max_tokens,
  );

  const recent: TaskSummaryDoc[] = [];
  let recentSelectionTokens = 0;
  for (const task of allTasks) {
    const taskTokens = estimateSummaryTokens(task) * 3;
    if (recentSelectionTokens + taskTokens > recentBudget) break;
    recent.push(task);
    recentSelectionTokens += taskTokens;
  }

  const mid = allTasks.slice(recent.length).slice(0, budget.mid_max_summaries);
  const early = allTasks.slice(recent.length + mid.length);
  return { recent, mid, early };
}

export function buildEarlyContextSummary(tasks: TaskSummaryDoc[]): ChatMessage {
  return {
    role: 'user',
    content:
      `[Earlier context] ${tasks.length} additional tasks completed. ` +
      `Topics: ${[...new Set(tasks.flatMap((t) => t.tech_concepts ?? []))].join(', ') || '(none)'}`,
  };
}

function buildMidContextSummary(task: TaskSummaryDoc): ChatMessage {
  return {
    role: 'user',
    content:
      `[Task ${task.task_id}] ${task.user_intent}\n` +
      `Files: ${(task.files_touched ?? []).join(', ') || '(none)'}\n` +
      `Tools: ${(task.tools_used ?? []).join(', ') || '(none)'}\n` +
      `Current work: ${task.current_work}`,
  };
}

/**
 * Build context messages from session history using sliding window.
 * Returns compressed messages that fit within budget.
 */
export function buildContext(session: SessionFile, budget: BudgetConfig): ChatMessage[] {
  if (session.tasks.length === 0) {
    return session.current_messages;
  }

  const { recent, mid, early } = selectTaskLayers(session.tasks, budget);
  const context: ChatMessage[] = [];
  const recentBudget = Math.min(
    budget.total * budget.recent_pct,
    budget.recent_max_tokens,
  );
  let recentMsgTokens = 0;

  for (const task of mid) {
    context.push(buildMidContextSummary(task));
  }

  if (early.length > 0) {
    context.unshift(buildEarlyContextSummary(early));
  }

  for (const task of [...recent].reverse()) {
    const msg: ChatMessage = {
      role: 'user',
      content: `[Recent task ${task.task_id}] ${task.current_work}`,
    };
    const msgTokens = estimateTokens([msg]);
    if (recentMsgTokens + msgTokens > recentBudget) break;
    context.push(msg);
    recentMsgTokens += msgTokens;
  }

  return [...context, ...session.current_messages];
}