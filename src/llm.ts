import type { ChatMessage, ToolCall, ToolDefinition } from './types.js';

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
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

export interface ChatOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  stream?: boolean;
  onToken?: (delta: string) => void;
}

export async function chat(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  opts: ChatOptions,
): Promise<LlmResult> {
  if (opts.stream) {
    return chatStream(messages, tools, opts);
  }
  return chatBlocking(messages, tools, opts);
}

async function chatBlocking(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  opts: ChatOptions,
): Promise<LlmResult> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = buildChatBody(opts.model, messages, tools, false);
  const bodyText = await postChat(url, opts.apiKey, body);

  const data = JSON.parse(bodyText) as ChatCompletionResponse;
  return parseCompletion(data);
}

async function chatStream(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  opts: ChatOptions,
): Promise<LlmResult> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(buildChatBody(opts.model, messages, tools, true)),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM HTTP ${res.status}: ${errText.slice(0, 500)}`);
  }

  if (!res.body) {
    throw new Error('LLM stream: empty body');
  }

  let content = '';
  const toolCallsByIndex = new Map<number, ToolCall>();
  let finishReason: string | null = null;
  let usage: ChatCompletionResponse['usage'];

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;

      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              type?: 'function';
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: ChatCompletionResponse['usage'];
      };

      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }

      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        opts.onToken?.(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallsByIndex.get(tc.index) ?? {
            id: tc.id ?? '',
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.function.name += tc.function.name;
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          toolCallsByIndex.set(tc.index, existing);
        }
      }
    }
  }

  const tool_calls =
    toolCallsByIndex.size > 0
      ? [...toolCallsByIndex.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => tc)
      : undefined;

  return {
    message: {
      role: 'assistant',
      content: content || null,
      tool_calls,
    },
    finishReason,
    usage,
  };
}

function buildChatBody(
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  } else {
    body.tool_choice = 'none';
  }
  return body;
}

async function postChat(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`LLM HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
  }
  return bodyText;
}

function parseCompletion(data: ChatCompletionResponse): LlmResult {
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