/**
 * Web UI re-export of shared runtime slash dispatch.
 * Prefer `import { … } from '../slash/index.js'` in new code.
 */

export {
  broadcastArmed,
  broadcastLlm,
  dispatchWebCommand,
  llmStatus,
  type CommandResult,
} from '../slash/dispatch-runtime.js';
