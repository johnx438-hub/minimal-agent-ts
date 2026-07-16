import { isToolArgsJsonValid } from '../tools/tool-args.js';
import type { ChatMessage, ToolCall } from '../types.js';
import {
  getMessageText,
  materializeVisionMessage,
  type VisionPolicyConfig,
} from '../vision.js';
import { getWorkspaceGrants } from '../workspace.js';

export interface AssembleApiMessagesOptions {
  cwd?: string;
  vision?: VisionPolicyConfig | null;
}

/**
 * Messages marked compacted_at are omitted from LLM requests (OpenCode-style prune).
 * Materializes vision_refs, strips internal fields, repairs tool_call pairs.
 */
export function assembleApiMessages(
  messages: ChatMessage[],
  opts?: AssembleApiMessagesOptions,
): ChatMessage[] {
  const cwd = opts?.cwd ?? process.cwd();
  const readableRoots = getWorkspaceGrants().map((g) => g.root);
  const visible = messages
    .filter((m) => !m.compacted_at)
    .map((m) =>
      materializeVisionMessage(m, {
        cwd,
        policy: opts?.vision,
        readableRoots,
      }),
    )
    .map(stripInternalMetadata);
  return repairToolCallPairs(visible);
}

/**
 * Drop orphan tool messages and trim assistant tool_calls to matching responses.
 * OpenAI-compatible APIs require each tool message to follow an assistant tool_calls block.
 */
export function repairToolCallPairs(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role !== 'assistant' || !msg.tool_calls?.length) {
      if (msg.role === 'tool') {
        i++;
        continue;
      }
      result.push(msg);
      i++;
      continue;
    }

    const calls = filterApiSafeToolCalls(msg.tool_calls);
    if (calls.length === 0) {
      if (hasNonEmptyContent(msg.content)) {
        result.push({ role: 'assistant', content: msg.content });
      }
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        j++;
      }
      i = j;
      continue;
    }

    const callIds = new Set(calls.map((c) => c.id));
    const toolsById = new Map<string, ChatMessage>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') {
      const tid = messages[j].tool_call_id;
      if (tid && callIds.has(tid) && !toolsById.has(tid)) {
        toolsById.set(tid, messages[j]);
      }
      j++;
    }

    const validCalls = calls.filter((c) => toolsById.has(c.id));
    if (validCalls.length > 0) {
      result.push({
        role: 'assistant',
        content: msg.content,
        tool_calls: validCalls,
      });
      for (const call of validCalls) {
        const tool = toolsById.get(call.id);
        if (tool) {
          result.push({
            role: 'tool',
            tool_call_id: tool.tool_call_id,
            content: tool.content,
          });
        }
      }
    } else if (hasNonEmptyContent(msg.content)) {
      result.push({ role: 'assistant', content: msg.content });
    }

    i = j;
  }

  return result;
}

function hasNonEmptyContent(content: ChatMessage['content']): boolean {
  if (content == null) return false;
  if (typeof content === 'string') return content !== '';
  return content.length > 0;
}

/** xAI and some providers reject assistant tool_calls whose arguments are not valid JSON. */
export function filterApiSafeToolCalls(calls: ToolCall[] | undefined): ToolCall[] {
  if (!calls?.length) return [];
  return calls.filter((c) => isToolArgsJsonValid(c.function.arguments));
}

/** Remove fields not accepted by OpenAI-compatible chat APIs. */
function stripInternalMetadata(msg: ChatMessage): ChatMessage {
  const {
    action_id: _a,
    pointerized: _p,
    compacted_at: _c,
    turn: _t,
    vision_refs: _v,
    ...apiMsg
  } = msg;
  return apiMsg;
}

/** Text extraction for callers that still assume string content. */
export { getMessageText };
