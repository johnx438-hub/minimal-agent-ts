import { chat, type ChatOptions, type LlmResult } from './llm.js';
import type { AgentStepEvent } from './events.js';
import type { ChatMessage, ToolDefinition } from './types.js';

/** In-memory streaming assistant text for the current turn (not in messages until commit). */
export interface AssistantDraft {
  turn: number;
  text: string;
}

export function createAssistantDraft(turn: number): AssistantDraft {
  return { turn, text: '' };
}

export function appendAssistantDraft(draft: AssistantDraft, delta: string): void {
  draft.text += delta;
}

export function commitAssistantText(
  messages: ChatMessage[],
  content: string,
  turn: number,
): void {
  messages.push({ role: 'assistant', content, turn });
}

export function commitAssistantToolCalls(
  messages: ChatMessage[],
  message: ChatMessage,
  turn: number,
): void {
  messages.push({
    role: 'assistant',
    content: message.content,
    tool_calls: message.tool_calls,
    turn,
  });
}

export interface LlmTurnOptions {
  turn: number;
  apiMessages: ChatMessage[];
  tools: ToolDefinition[];
  chatOpts: ChatOptions;
  stream: boolean;
  onStep?: (event: AgentStepEvent) => void;
}

/**
 * Run one LLM call with a turn-scoped draft. Tokens update draft + onStep only.
 * Committed messages are added by the caller after a successful result.
 */
export async function invokeLlmTurn(opts: LlmTurnOptions): Promise<LlmResult> {
  const { turn, apiMessages, tools, chatOpts, stream, onStep } = opts;
  const draft = createAssistantDraft(turn);

  try {
    return await chat(apiMessages, tools, {
      ...chatOpts,
      onToken: stream
        ? (delta) => {
            appendAssistantDraft(draft, delta);
            onStep?.({ type: 'token', turn, delta });
          }
        : undefined,
    });
  } catch (err) {
    if (draft.text.length > 0) {
      onStep?.({ type: 'draft_discarded', turn, chars: draft.text.length });
    }
    throw err;
  }
}