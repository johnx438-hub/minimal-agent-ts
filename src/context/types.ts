import type { PreviewPolicy } from '../action-preview.js';
import type { BudgetConfig } from './budget.js';
import type { ChatMessage, SessionFile } from '../types.js';

/** Per-turn input for turn-end context management (L2 pipeline). */
export interface TurnContext {
  messages: ChatMessage[];
  turn: number;
  budget: BudgetConfig;
  userTask: ChatMessage;
  session?: SessionFile;
  keepInlineTurns?: number;
  previewPolicy?: PreviewPolicy;
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