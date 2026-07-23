import type { ContextPolicy } from '../plugins/types.js';
import type { PointerizePolicy } from '../plugins/types.js';

/** Strategy overlay file under eval/strategies/*.json */
export interface EvalStrategyFile {
  _id?: string;
  _comment?: string;
  pointerize_policy?: PointerizePolicy;
  context_policy?: ContextPolicy;
}

export interface EvalTaskMeta {
  id: string;
  family?: string;
  noise?: string;
  max_turns?: number;
  timeout_sec?: number;
  tools?: string;
  acceptance?: string;
  description?: string;
}

export interface EvalTurnRecord {
  turn: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cache_cached_tokens?: number;
  tool_calls: Array<{ name: string; args_fp: string; call_id: string }>;
  pointerized?: number;
  pruned?: number;
  pointer_compacted?: number;
  heavy_compression?: boolean;
  loop_guard_actions: string[];
  wall_ms?: number;
}

export interface EvalManifest {
  schema_version: 1;
  run_id: string;
  task_id: string;
  strategy_id: string;
  git_sha: string | null;
  package_version: string;
  model: string;
  base_url_host: string | null;
  max_turns: number;
  timeout_sec: number | null;
  allow_shell: boolean;
  allow_web: boolean;
  workdir: string;
  project_root: string;
  dry_run: boolean;
  started_at: string;
  finished_at?: string;
  wall_ms?: number;
  pointerize_policy?: PointerizePolicy;
  context_policy?: ContextPolicy;
  task_meta: EvalTaskMeta;
}

export interface EvalSummary {
  run_id: string;
  task_id: string;
  strategy_id: string;
  task_success: boolean;
  score: unknown;
  turns_used: number;
  repeat_tool_rate: number;
  hot_tokens_mean: number | null;
  hot_tokens_p95: number | null;
  prompt_tokens_total: number;
  completion_tokens_total: number;
  tool_calls_total: number;
  compression_events: number;
  heavy_compression_count: number;
  loop_guard_count: number;
  final_text_preview: string;
  error?: string;
  /**
   * Optional cost estimate (USD) when EVAL_PRICE_PROMPT_PER_1M /
   * EVAL_PRICE_COMPLETION_PER_1M are set (dollars per 1M tokens).
   */
  cost_usd_est?: number | null;
}

export interface EvalRunOptions {
  /** Repo root (agent.json / .env). */
  projectRoot: string;
  /** Eval tree root (default projectRoot/eval). */
  evalRoot?: string;
  taskId: string;
  strategyId: string;
  maxTurns?: number;
  timeoutSec?: number;
  allowShell?: boolean;
  allowWeb?: boolean;
  /**
   * Skip LLM: setup workspace, write dry-run artifacts, optional plant answer, score.
   */
  dryRun?: boolean;
  /** With dryRun: copy fixtures/answer.correct.json before score. */
  plantCorrectAnswer?: boolean;
  /** Override run output directory parent (default eval/runs). */
  runsDir?: string;
  runId?: string;
}
