import type { ChatMessage } from './types.js';

/**
 * Messages marked compacted_at are omitted from LLM requests (OpenCode-style prune).
 * Phase 2c will write these; Phase 2a only filters if present.
 */
export function assembleApiMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((m) => !m.compacted_at)
    .map(stripInternalMetadata);
}

/** Remove fields not accepted by OpenAI-compatible chat APIs. */
function stripInternalMetadata(msg: ChatMessage): ChatMessage {
  const {
    action_id: _a,
    pointerized: _p,
    compacted_at: _c,
    turn: _t,
    ...apiMsg
  } = msg;
  return apiMsg;
}