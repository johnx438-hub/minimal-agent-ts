import {
  maybeCompactPointerCards,
  runCompressionEvent,
} from '../context-policy.js';
import { maybePrune } from './prune.js';
import { runPointerizeStage } from './pointerize-stage.js';
import {
  EMPTY_PIPELINE_RESULT,
  type TurnContext,
  type TurnPipelineResult,
} from './types.js';

/**
 * Turn-end context pipeline (L2-0 scaffold).
 * Stages delegate to context modules / pointerize until L2-4..L2-5 file split.
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