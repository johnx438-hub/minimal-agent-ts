/**
 * Vendor-neutral thinking / reasoning trace helpers (SPEC_LLM_ROUTER).
 *
 * Inbound: Kimi + DeepSeek-style APIs put CoT on `reasoning_content`
 * (sometimes `reasoning`). We normalize to ChatMessage.reasoning_content.
 *
 * Outbound: re-send only when profile.preserve_reasoning is true
 * (Kimi needs this for prefix cache + Preserved Thinking; other providers
 * may reject unknown fields).
 */

import type { ChatMessage } from './types.js';

/** Pull reasoning text from a completion message or stream delta object. */
export function extractReasoningText(source: unknown): string | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return undefined;
  }
  const obj = source as Record<string, unknown>;
  for (const key of ['reasoning_content', 'reasoning'] as const) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** Non-empty trim; empty → undefined. */
export function normalizeReasoningText(
  text: string | null | undefined,
): string | undefined {
  if (text == null) return undefined;
  const t = text.trim();
  return t.length > 0 ? t : undefined;
}

export function appendReasoningDelta(
  acc: string,
  delta: unknown,
): string {
  const piece = extractReasoningText(delta);
  if (!piece) return acc;
  return acc + piece;
}

/** Attach reasoning_content when non-empty (immutable). */
export function withReasoningContent(
  msg: ChatMessage,
  reasoning: string | undefined,
): ChatMessage {
  const r = normalizeReasoningText(reasoning);
  if (!r) return msg;
  return { ...msg, reasoning_content: r };
}

/**
 * Copy reasoning onto an API-bound assistant message, or omit.
 * When preserve is false, drop the field even if present on disk.
 */
export function projectReasoningForApi(
  msg: ChatMessage,
  preserve: boolean,
): ChatMessage {
  if (msg.role !== 'assistant') return msg;
  if (!preserve) {
    if (msg.reasoning_content === undefined) return msg;
    const { reasoning_content: _r, ...rest } = msg;
    return rest;
  }
  const r = normalizeReasoningText(msg.reasoning_content);
  if (!r) {
    if (msg.reasoning_content === undefined) return msg;
    const { reasoning_content: _r, ...rest } = msg;
    return rest;
  }
  return { ...msg, reasoning_content: r };
}
