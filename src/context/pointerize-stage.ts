import { materializePriorTurnTools } from '../pointerize.js';
import type { TurnContext } from './types.js';

/** Stage 0: pointerize eligible prior-turn tool bodies before prune/compact. */
export function runPointerizeStage(ctx: TurnContext): number {
  return materializePriorTurnTools(ctx.messages, ctx.turn, {
    keepInlineTurns: ctx.keepInlineTurns ?? 2,
    previewPolicy: ctx.previewPolicy,
  });
}