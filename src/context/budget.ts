import type { ChatMessage, SessionFile, TaskSummaryDoc } from '../types.js';
import { estimateVisionTokens, getMessageText } from '../vision.js';
import type { ResolvedContextPolicy } from './policy-config.js';

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

  /** First heavy compression vs usable (SPEC_CONTEXT_POLICY). Default 0.8. */
  first_heavy_ratio: number;
  /** Repeat heavy vs usable (hysteresis). Default 0.9. */
  repeat_heavy_ratio: number;
  /** Floor for resume live-history budget. Default MIN_RESUME_HISTORY_TOKENS. */
  min_resume_history_tokens: number;
}

/** Default budget when model unknown and MAX_CONTEXT_TOKENS unset. */
export const DEFAULT_CONTEXT_TOKENS = 200_000;

/** First heavy compression: 80% of usable context. */
export const FIRST_HEAVY_COMPRESSION_RATIO = 0.8;

/** Subsequent heavy compression: 90% of usable context (hysteresis). */
export const REPEAT_HEAVY_COMPRESSION_RATIO = 0.9;

/** Minimum live-history tokens kept on resume even when layers are large. */
export const MIN_RESUME_HISTORY_TOKENS = 4_000;

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
  first_heavy_ratio: FIRST_HEAVY_COMPRESSION_RATIO,
  repeat_heavy_ratio: REPEAT_HEAVY_COMPRESSION_RATIO,
  min_resume_history_tokens: MIN_RESUME_HISTORY_TOKENS,
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
 * Optional resolved context_policy (SPEC_CONTEXT_POLICY C2) overrides layer % and heavy ratios.
 */
export function createBudgetConfig(
  model: string,
  contextPolicy?: ResolvedContextPolicy | null,
): BudgetConfig {
  const total = getMaxContextTokens(model);
  const b = contextPolicy?.budget;
  const heavy = contextPolicy?.heavy_compression;
  const resume = contextPolicy?.resume;

  const system_pct = b?.system_pct ?? DEFAULT_BUDGET.system_pct;
  const current_pct = b?.current_pct ?? DEFAULT_BUDGET.current_pct;
  const recent_pct = b?.recent_pct ?? DEFAULT_BUDGET.recent_pct;
  const mid_pct = b?.mid_pct ?? DEFAULT_BUDGET.mid_pct;
  const early_pct = b?.early_pct ?? DEFAULT_BUDGET.early_pct;
  const recent_max_base = b?.recent_max_tokens ?? DEFAULT_BUDGET.recent_max_tokens;
  const mid_max_summaries = b?.mid_max_summaries ?? DEFAULT_BUDGET.mid_max_summaries;
  const recentCap = Math.floor(total * recent_pct);

  return {
    total,
    system_pct,
    current_pct,
    recent_pct,
    mid_pct,
    early_pct,
    recent_max_tokens: Math.max(recent_max_base, recentCap),
    mid_max_summaries,
    first_heavy_ratio: heavy?.first_ratio ?? DEFAULT_BUDGET.first_heavy_ratio,
    repeat_heavy_ratio: heavy?.repeat_ratio ?? DEFAULT_BUDGET.repeat_heavy_ratio,
    min_resume_history_tokens:
      resume?.min_history_tokens ?? DEFAULT_BUDGET.min_resume_history_tokens,
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
    total += estimateTextTokens(getMessageText(msg.content));
    total += estimateVisionTokens(msg);
    total += msg.role === 'tool' ? 5 : 2;
    if (msg.tool_calls) {
      total += msg.tool_calls.length * 10;
    }
  }
  return total;
}

/**
 * Rough token estimate for chat-completions `tools` array (JSON schema on the wire).
 * Used with message estimates when calibrating against usage.prompt_tokens.
 */
export function estimateToolDefsTokens(tools: unknown): number {
  if (tools == null) return 0;
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  try {
    const json = JSON.stringify(tools);
    if (!json) return 0;
    return estimateTextTokens(json) + tools.length * 4;
  } catch {
    return 0;
  }
}

/**
 * Prompt-side estimate: messages + optional tool defs, optionally scaled by calibrator.
 * When cal is omitted, returns raw local estimate (tests / default path).
 */
export function estimatePromptTokens(
  messages: ChatMessage[],
  tools?: unknown,
  cal?: { apply(raw: number): number } | null,
): number {
  const raw = estimateTokens(messages) + estimateToolDefsTokens(tools);
  return cal ? cal.apply(raw) : raw;
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

export function usableContextTokens(budget: BudgetConfig): number {
  return budget.total * (1 - budget.system_pct);
}

export function heavyCompressionThreshold(
  budget: BudgetConfig,
  isRepeat: boolean,
): number {
  const ratio = isRepeat
    ? (budget.repeat_heavy_ratio ?? REPEAT_HEAVY_COMPRESSION_RATIO)
    : (budget.first_heavy_ratio ?? FIRST_HEAVY_COMPRESSION_RATIO);
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

export function buildMidContextSummary(task: TaskSummaryDoc): ChatMessage {
  return {
    role: 'user',
    content:
      `[Task ${task.task_id}] ${task.user_intent}\n` +
      `Files: ${(task.files_touched ?? []).join(', ') || '(none)'}\n` +
      `Tools: ${(task.tools_used ?? []).join(', ') || '(none)'}\n` +
      `Current work: ${task.current_work}`,
  };
}

export interface LayerBudgets {
  recent: number;
  mid: number;
  early: number;
}

export function layerBudgets(budget: BudgetConfig): LayerBudgets {
  return {
    recent: Math.min(budget.total * budget.recent_pct, budget.recent_max_tokens),
    mid: budget.total * budget.mid_pct,
    early: budget.total * budget.early_pct,
  };
}

/**
 * Token budget for live `current_messages` after task-layer summaries are built.
 * Leaves room for system + new user task; caps by recent_max so long sessions
 * do not re-send the entire transcript on resume.
 */
export function resumeHistoryBudget(
  budget: BudgetConfig,
  layerTokens: number,
): number {
  const usable = usableContextTokens(budget);
  const systemReserve = Math.floor(budget.total * budget.system_pct);
  const currentReserve = Math.floor(budget.total * budget.current_pct);
  const remaining = usable - layerTokens - currentReserve;
  const capped = Math.min(budget.recent_max_tokens, remaining);
  const floor = budget.min_resume_history_tokens ?? MIN_RESUME_HISTORY_TOKENS;
  return Math.max(floor, Math.floor(capped));
}

/**
 * How many leading messages form one droppable unit (assistant+tools or single msg).
 * Keeps tool_call groups intact when trimming from the front.
 */
function frontGroupSize(messages: ChatMessage[]): number {
  if (messages.length === 0) return 0;
  const first = messages[0];
  if (first.role === 'assistant' && first.tool_calls && first.tool_calls.length > 0) {
    let n = 1;
    while (n < messages.length && messages[n].role === 'tool') n++;
    return n;
  }
  return 1;
}

/**
 * Select a suffix of session messages under a token budget for resume.
 *
 * - Skips system + compacted_at (view only; does not mutate session)
 * - Never rewrites content (pointer cards stay as-is, including [action:…] text)
 * - Preserves message object identity and metadata (action_id, pointerized, turn)
 * - Drops oldest complete assistant/tool groups when over budget
 */
export function selectHistoryWithinBudget(
  messages: ChatMessage[],
  tokenBudget: number,
): ChatMessage[] {
  const candidates = messages.filter(
    (m) => m.role !== 'system' && !m.compacted_at,
  );
  if (candidates.length === 0) return [];
  if (tokenBudget <= 0) {
    // Keep the last user message when possible so resume is not empty.
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i].role === 'user') return [candidates[i]];
    }
    return [candidates[candidates.length - 1]];
  }

  if (estimateTokens(candidates) <= tokenBudget) {
    return candidates;
  }

  // Grow a suffix from the end until budget is exhausted.
  let tokens = 0;
  let start = candidates.length;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const t = estimateTokens([candidates[i]]);
    if (start < candidates.length && tokens + t > tokenBudget) {
      break;
    }
    tokens += t;
    start = i;
  }

  // If the suffix starts mid tool-response, include the parent assistant.
  while (start > 0 && candidates[start].role === 'tool') {
    start--;
  }

  let slice = candidates.slice(start);

  // Drop oldest complete groups until under budget (or a single message remains).
  while (slice.length > 1 && estimateTokens(slice) > tokenBudget) {
    const drop = frontGroupSize(slice);
    // Avoid dropping everything if one huge message remains at the end.
    if (drop >= slice.length) {
      slice = slice.slice(-1);
      break;
    }
    slice = slice.slice(drop);
  }

  return slice;
}

/**
 * Build context messages from session history using sliding window.
 * Task-layer summaries + budgeted live history (not full current_messages dump).
 */
export function buildContext(session: SessionFile, budget: BudgetConfig): ChatMessage[] {
  if (session.tasks.length === 0) {
    return session.current_messages;
  }

  const { recent, mid, early } = selectTaskLayers(session.tasks, budget);
  const { recent: recentBudget, mid: midBudget, early: earlyBudget } = layerBudgets(budget);
  const context: ChatMessage[] = [];
  const midOverflow: TaskSummaryDoc[] = [];
  let midMsgTokens = 0;

  for (const task of mid) {
    const summaryMsg = buildMidContextSummary(task);
    const msgTokens = estimateTokens([summaryMsg]);
    if (midMsgTokens + msgTokens > midBudget) {
      midOverflow.push(task);
      continue;
    }
    context.push(summaryMsg);
    midMsgTokens += msgTokens;
  }

  const earlyTasks = [...early, ...midOverflow];
  if (earlyTasks.length > 0) {
    const earlySummary = buildEarlyContextSummary(earlyTasks);
    if (estimateTokens([earlySummary]) <= earlyBudget) {
      context.unshift(earlySummary);
    }
  }

  let recentMsgTokens = 0;
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

  const historyBudget = resumeHistoryBudget(budget, estimateTokens(context));
  const history = selectHistoryWithinBudget(session.current_messages, historyBudget);
  return [...context, ...history];
}