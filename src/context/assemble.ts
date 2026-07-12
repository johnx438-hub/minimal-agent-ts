import { isToolArgsJsonValid } from '../tools/tool-args.js';
import type { ChatMessage, ToolCall } from '../types.js';

/**
 * Messages marked compacted_at are omitted from LLM requests (OpenCode-style prune).
 * Repairs assistant/tool_call pairs so APIs never see orphan tool messages.
 */
export function assembleApiMessages(messages: ChatMessage[]): ChatMessage[] {
  const visible = messages.filter((m) => !m.compacted_at).map(stripInternalMetadata);
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
      if (msg.content != null && msg.content !== '') {
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
    } else if (msg.content != null && msg.content !== '') {
      result.push({ role: 'assistant', content: msg.content });
    }

    i = j;
  }

  return result;
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
    ...apiMsg
  } = msg;
  return apiMsg;
}