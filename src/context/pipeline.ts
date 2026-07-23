import type { AgentStepEvent } from '../events.js';
import { runCompressionEvent } from './heavy-compression.js';
import { maybeCompactPointerCards } from './pointer-compact.js';
import { runPointerizeStage } from './pointerize-stage.js';
import { maybePrune } from './prune.js';
import {
  EMPTY_PIPELINE_RESULT,
  type TurnContext,
  type TurnPipelineResult,
} from './types.js';

/** True when every pipeline stage was a no-op (turn 1 or no eligible work). */
export function isTurnPipelineNoop(result: TurnPipelineResult): boolean {
  return (
    result.pointerized === 0 &&
    result.pruned === 0 &&
    result.pointer_compacted === 0 &&
    !result.heavy_compression
  );
}

/** Map TurnPipelineResult to a single compression step event (null if noop). */
export function buildCompressionStepEvent(
  turn: number,
  result: TurnPipelineResult,
): Extract<AgentStepEvent, { type: 'compression' }> | null {
  if (isTurnPipelineNoop(result)) {
    return null;
  }
  return {
    type: 'compression',
    turn,
    pointerized: result.pointerized,
    pruned: result.pruned,
    pointer_compacted: result.pointer_compacted,
    heavy_compression: result.heavy_compression,
  };
}

export function emitTurnPipelineSteps(
  turn: number,
  result: TurnPipelineResult,
  onStep?: (event: AgentStepEvent) => void,
): void {
  const event = buildCompressionStepEvent(turn, result);
  if (event) {
    onStep?.(event);
  }
}

/** Turn-end context pipeline: pointerize → prune → pointer-compact → heavy compression. */
export function runTurnEndPipeline(ctx: TurnContext): TurnPipelineResult {
  if (ctx.turn <= 1) {
    return EMPTY_PIPELINE_RESULT;
  }

  const pointerized = runPointerizeStage(ctx);
  const pruned = maybePrune(ctx.messages, ctx.turn);
  const pointer_compacted = maybeCompactPointerCards(
    ctx.messages,
    ctx.turn,
    ctx.budget,
    ctx.calibrator,
  );
  const heavy_compression = runCompressionEvent({
    messages: ctx.messages,
    session: ctx.session,
    currentTurn: ctx.turn,
    budget: ctx.budget,
    userTask: ctx.userTask,
    skipPointerCompact: true,
    calibrator: ctx.calibrator,
  });

  return { pointerized, pruned, pointer_compacted, heavy_compression };
}

/** Run turn-end pipeline and emit a single compression step event when any stage ran. */
export function runTurnEndCompression(
  ctx: TurnContext,
  onStep?: (event: AgentStepEvent) => void,
): TurnPipelineResult {
  const result = runTurnEndPipeline(ctx);
  emitTurnPipelineSteps(ctx.turn, result, onStep);
  return result;
}