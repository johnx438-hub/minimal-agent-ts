import type { ChatMessage, ToolDefinition } from './types.js';

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface LlmResult {
  message: ChatMessage;
  finishReason: string | null;
  usage?: ChatCompletionResponse['usage'];
}

export async function chat(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  opts: { apiKey: string; baseUrl: string; model: string },
): Promise<LlmResult> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages,
      tools,
      tool_choice: 'auto',
    }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`LLM HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
  }

  const data = JSON.parse(bodyText) as ChatCompletionResponse;
  const choice = data.choices[0];
  if (!choice) {
    throw new Error('LLM returned no choices');
  }

  return {
    message: {
      role: 'assistant',
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
    },
    finishReason: choice.finish_reason,
    usage: data.usage,
  };
}