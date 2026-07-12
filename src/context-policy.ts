/** @deprecated Import from `./context/*.js`; re-exports preserved for compatibility. */

export {
  assembleApiMessages,
  filterApiSafeToolCalls,
  repairToolCallPairs,
} from './context/assemble.js';

export {
  PROTECT_RECENT_TOKENS,
  PROTECT_USER_TURNS,
  estimatePruneSavings,
} from './context/estimate.js';

export {
  PRUNE_MIN_SAVINGS,
  releaseCompactedContent,
  releaseAllCompactedContent,
  shouldPrune,
  applyPrune,
  maybePrune,
} from './context/prune.js';

export {
  MAX_POINTER_COMPACT_PER_TURN,
  pointerCompactThreshold,
  shouldCompactPointerCards,
  applyPointerSecondaryCompact,
  compactPointerCardsUntilUnderBudget,
  maybeCompactPointerCards,
} from './context/pointer-compact.js';

export {
  hasCompressionNotice,
  hasTaskSummaryBlock,
  buildTaskSummaryMessages,
  appendCompressionNotice,
  replayLastUserTask,
  runCompressionEvent,
  type CompressionEventOptions,
} from './context/heavy-compression.js';