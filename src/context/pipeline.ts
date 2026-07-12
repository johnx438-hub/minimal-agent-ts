import { runCompressionEvent } from './heavy-compression.js';
import { maybeCompactPointerCards } from './pointer-compact.js';
import { maybePrune } from './prune.js';
import { runPointerizeStage } from './pointerize-stage.js';
import {
  EMPTY_PIPELINE_RESULT,
  type TurnContext,
  type TurnPipelineResult,
} from './types.js';

/**
 * Turn-end context pipeline (L2-0 scaffold).
 * Turn-end context pipeline: pointerize → prune → pointer-compact → heavy compression.
 */
export function runTurnEndPipeline(ctx: TurnContext): TurnPipelineResult {
  if (ctx.turn <= 1) {
    return EMPTY_PIPELINE_RESULT;
  }

  runPointerizeStage(ctx);

  const pruned = maybePrune(ctx.messages, ctx.turn);
  const pointer_compacted = maybeCompactPointerCards(
    ctx.messages,
    ctx.turn,
    ctx.budget,
  );
  const heavy_compression = runCompressionEvent({
    messages: ctx.messages,
    session: ctx.session,
    currentTurn: ctx.turn,
    budget: ctx.budget,
    userTask: ctx.userTask,
  });

  return { pruned, pointer_compacted, heavy_compression };
}