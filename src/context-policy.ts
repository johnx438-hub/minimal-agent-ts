/** @deprecated Import from `./context/*.js`; re-exports preserved for compatibility. */

export {
  assembleApiMessages,
  filterApiSafeToolCalls,
  repairToolCallPairs,
} from './context/assemble.js';

export {
  ESTIMATE_SCALE_VS_LEGACY,
  PROTECT_RECENT_TOKENS,
  PROTECT_USER_TURNS,
  estimatePruneSavings,
} from './context/estimate.js';

export {
  TokenCalibrator,
  readPromptTokensFromUsage,
  ratioSample,
  ewmaUpdate,
  DEFAULT_CALIBRATOR_ALPHA,
  DEFAULT_SCALE_MIN,
  DEFAULT_SCALE_MAX,
  DEFAULT_MIN_RAW,
  type TokenCalibratorOptions,
  type TokenCalibratorSnapshot,
} from './context/token-calibrator.js';

export {
  defaultResolvedContextPolicy,
  mergeContextPolicy,
  normalizeContextPolicy,
  type ResolvedContextPolicy,
} from './context/policy-config.js';

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