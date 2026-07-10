import type { ChatMessage, SessionFile, TaskSummaryDoc } from './types.js';

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

/**
 * Estimate token count for messages.
 * Simplified approach: ~1.3 tokens per word + overhead for special tokens.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const text = msg.content ?? '';
    // Rough estimation: 1.3 tokens per whitespace-separated word
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    total += Math.ceil(words * 1.3);
    
    // Add overhead for role and tool_call metadata
    total += msg.role === 'tool' ? 5 : 2;
    if (msg.tool_calls) {
      total += msg.tool_calls.length * 10;
    }
  }
  return total;
}

/**
 * Estimate token count for a task summary.
 */
export function estimateSummaryTokens(summary: TaskSummaryDoc): number {
  const text = [
    summary.user_intent,
    ...summary.user_messages,
    ...summary.files_touched,
    ...summary.tech_concepts,
    ...summary.tools_used,
    ...summary.pending_tasks,
    summary.current_work,
  ].join(' ');
  
  return Math.ceil(text.split(/\s+/).length * 1.3);
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

/**
 * Build context messages from session history using sliding window.
 * Returns compressed messages that fit within budget.
 */
export function buildContext(session: SessionFile, budget: BudgetConfig): ChatMessage[] {
  const allTasks = [...session.tasks].reverse(); // Most recent first
  if (allTasks.length === 0) {
    return session.current_messages;
  }
  
  const context: ChatMessage[] = [];
  let usedTokens = 0;
  
  const recentBudget = Math.min(
    budget.total * budget.recent_pct,
    budget.recent_max_tokens
  );
  const midBudget = budget.total * budget.mid_pct;
  
  // Layer 1: Recent - full task messages (up to recent_budget or recent_max_tokens)
  let recentTasks: TaskSummaryDoc[] = [];
  for (const task of allTasks) {
    const taskTokens = estimateSummaryTokens(task) * 3; // Estimate full task is ~3x summary
    if (usedTokens + taskTokens > recentBudget) break;
    
    recentTasks.push(task);
    usedTokens += taskTokens;
  }
  
  // Layer 2: Mid-term - task summaries (up to mid_budget or mid_max_summaries)
  const midTasks = allTasks.slice(recentTasks.length, budget.mid_max_summaries);
  for (const task of midTasks) {
    const summaryMsg: ChatMessage = {
      role: 'user',
      content: `[Task ${task.task_id}] ${task.user_intent}\n` +
               `Files: ${task.files_touched.join(', ')}\n` +
               `Tools: ${task.tools_used.join(', ')}\n` +
               `Current work: ${task.current_work}`,
    };
    
    context.push(summaryMsg);
    usedTokens += estimateTokens([summaryMsg]);
  }
  
  // Layer 3: Early - session-level summary (if more tasks remain)
  const remainingTasks = allTasks.slice(budget.mid_max_summaries);
  if (remainingTasks.length > 0) {
    const earlySummary: ChatMessage = {
      role: 'user',
      content: `[Earlier context] ${remainingTasks.length} additional tasks completed. ` +
               `Topics: ${[...new Set(remainingTasks.flatMap(t => t.tech_concepts))].join(', ')}`,
    };
    context.unshift(earlySummary); // Add to beginning
  }
  
  // Add recent full messages (simulated - in Phase 2+, these would be actual action_blocks)
  for (const task of recentTasks.slice(-3)) { // Last 3 tasks as "recent"
    const msg: ChatMessage = {
      role: 'user',
      content: `[Recent task ${task.task_id}] ${task.current_work}`,
    };
    context.push(msg);
  }
  
  return [...context, ...session.current_messages];
}
