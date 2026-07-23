import {
  materializePriorTurnTools,
  shouldForcePointerize,
  tickPointerizeFocus,
} from '../pointerize.js';
import type { TurnContext } from './types.js';

/** Stage 0: pointerize eligible prior-turn tool bodies before prune/compact. */
export function runPointerizeStage(ctx: TurnContext): number {
  const force = shouldForcePointerize(
    ctx.messages,
    ctx.budget,
    ctx.pointerizePolicy,
    ctx.calibrator,
  );
  const n = materializePriorTurnTools(ctx.messages, ctx.turn, {
    keepInlineTurns: ctx.keepInlineTurns ?? 2,
    previewPolicy: ctx.previewPolicy,
    pointerizePolicy: ctx.pointerizePolicy,
    pointerizeMode: ctx.pointerizeMode,
    pointerizeFocus: ctx.pointerizeFocus,
    force,
  });

  // Tick context_focus TTL once per turn-end stage.
  if (ctx.configRef?.pointerizeFocus) {
    const expired = tickPointerizeFocus(ctx.configRef.pointerizeFocus);
    if (expired) {
      delete ctx.configRef.pointerizeFocus;
    }
  }

  return n;
}
