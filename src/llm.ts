import { LlmHttpError, parseRetryAfterMs } from './llm-retry.js';
import {
  appendReasoningDelta,
  extractReasoningText,
  normalizeReasoningText,
} from './llm-reasoning-content.js';
import type { ChatMessage, ToolCall, ToolDefinition } from './types.js';

export { LlmHttpError } from './llm-retry.js';

/** OpenAI base usage + vendor extensions (DeepSeek / GLM / xAI / OpenRouter / Kimi). */
export type LlmUsage = Record<string, unknown> & {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Moonshot/Kimi often put cache hits at usage root. */
  cached_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
};

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
      reasoning_content?: string | null;
      reasoning?: string | null;
    };
    finish_reason: string | null;
  }>;
  usage?: LlmUsage;
}

export interface LlmResult {
  message: ChatMessage;
  finishReason: string | null;
  usage?: LlmUsage;
}

export interface ChatOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  stream?: boolean;
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
  /** Shallow-merged into chat/completions body after defaults (profile + cache adapter). */
  extraBody?: Record<string, unknown>;
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
  const body = buildChatBody(opts.model, messages, tools, false, opts.extraBody);
  const bodyText = await postChat(url, opts.apiKey, body, opts.signal, opts);

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
    body: JSON.stringify(buildChatBody(opts.model, messages, tools, true, opts.extraBody)),
    signal: opts.signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new LlmHttpError(
      res.status,
      formatLlmAuthErrorBody(res.status, errText, opts),
      parseRetryAfterMs(res.headers.get('retry-after')),
    );
  }

  if (!res.body) {
    throw new Error('LLM stream: empty body');
  }

  let content = '';
  let reasoningAcc = '';
  const toolCallsByIndex = new Map<number, ToolCall>();
  let finishReason: string | null = null;
  let usage: ChatCompletionResponse['usage'];

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    if (opts.signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new DOMException('Aborted', 'AbortError');
    }
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
            reasoning_content?: string | null;
            reasoning?: string | null;
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

      reasoningAcc = appendReasoningDelta(reasoningAcc, delta);

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

  const reasoning_content = normalizeReasoningText(reasoningAcc);
  return {
    message: {
      role: 'assistant',
      content: content || null,
      tool_calls,
      ...(reasoning_content ? { reasoning_content } : {}),
    },
    finishReason,
    usage,
  };
}

export function buildChatBody(
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  stream: boolean,
  extraBody?: Record<string, unknown>,
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
  if (extraBody) {
    Object.assign(body, extraBody);
  }
  return body;
}

async function postChat(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  diag?: ChatOptions,
): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new LlmHttpError(
      res.status,
      formatLlmAuthErrorBody(res.status, bodyText, diag ?? { apiKey, baseUrl: url, model: '' }),
      parseRetryAfterMs(res.headers.get('retry-after')),
    );
  }
  return bodyText;
}

/** Append profile/host/key fingerprint on auth failures so mixed profile bugs are obvious. */
function formatLlmAuthErrorBody(
  status: number,
  bodyText: string,
  opts: Pick<ChatOptions, 'apiKey' | 'baseUrl' | 'model'>,
): string {
  if (status !== 401 && status !== 403) return bodyText;
  try {
    const host = new URL(opts.baseUrl).host;
    const suf =
      opts.apiKey.trim().length >= 4 ? opts.apiKey.trim().slice(-4) : '?';
    return (
      `${bodyText}\n` +
      `[auth diag] host=${host} model=${opts.model} key=…${suf} ` +
      `(if key suffix is from another provider, profile credentials are mixed — /profile reset or restart TUI after editing .env)`
    );
  } catch {
    return bodyText;
  }
}

function parseCompletion(data: ChatCompletionResponse): LlmResult {
  const choice = data.choices[0];
  if (!choice) {
    throw new Error('LLM returned no choices');
  }

  const reasoning_content = normalizeReasoningText(
    extractReasoningText(choice.message),
  );

  return {
    message: {
      role: 'assistant',
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
      ...(reasoning_content ? { reasoning_content } : {}),
    },
    finishReason: choice.finish_reason,
    usage: data.usage,
  };
}