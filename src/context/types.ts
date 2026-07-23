import type { PreviewPolicy } from '../action-preview.js';
import type { PointerizeMode, PointerizePolicy } from '../plugins/types.js';
import type { BudgetConfig } from './budget.js';
import type { ResolvedContextPolicy } from './policy-config.js';
import type { TokenCalibrator } from './token-calibrator.js';
import type { AgentConfig, ChatMessage, SessionFile } from '../types.js';

/** Per-turn input for turn-end context management (L2 pipeline). */
export interface TurnContext {
  messages: ChatMessage[];
  turn: number;
  budget: BudgetConfig;
  userTask: ChatMessage;
  session?: SessionFile;
  keepInlineTurns?: number;
  pointerizePolicy?: PointerizePolicy;
  pointerizeMode?: PointerizeMode;
  pointerizeFocus?: AgentConfig['pointerizeFocus'];
  /** Mutable config ref so focus ttl can be ticked. */
  configRef?: AgentConfig;
  previewPolicy?: PreviewPolicy;
  /**
   * Session-scoped token scale (API prompt_tokens / local estimate).
   * When set, heavy / pointer-compact / soft-force use calibrated estimates.
   */
  calibrator?: TokenCalibrator;
  /**
   * Normalized context_policy (SPEC_CONTEXT_POLICY C2).
   * Protect / prune / compact thresholds; budget ratios already on `budget`.
   */
  contextPolicy?: ResolvedContextPolicy;
}

/** Stage counters emitted by runTurnEndPipeline (maps to compression events). */
export interface TurnPipelineResult {
  pointerized: number;
  pruned: number;
  pointer_compacted: number;
  heavy_compression: boolean;
}

export const EMPTY_PIPELINE_RESULT: TurnPipelineResult = {
  pointerized: 0,
  pruned: 0,
  pointer_compacted: 0,
  heavy_compression: false,
};