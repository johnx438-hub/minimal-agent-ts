import { loadAction } from './action-store.js';
import type { ActionBlock, ChatMessage } from './types.js';

export const POINTER_RULES: Record<
  string,
  { minChars: number; alwaysIfLines?: number }
> = {
  read_file: { minChars: 600, alwaysIfLines: 40 },
  run_shell: { minChars: 800, alwaysIfLines: 30 },
  write_file: { minChars: Number.POSITIVE_INFINITY },
  grep_search: { minChars: 500, alwaysIfLines: 20 },
  list_files: { minChars: 500, alwaysIfLines: 30 },
  diff_file: { minChars: 600, alwaysIfLines: 30 },
  recall_query: { minChars: 600, alwaysIfLines: 30 },
};

const NEVER_POINTERIZE_PREFIXES = ['error:', 'ok: wrote'];

export function shouldPointerize(toolName: string, raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (NEVER_POINTERIZE_PREFIXES.some((p) => trimmed.startsWith(p))) {
    return false;
  }

  const rule = POINTER_RULES[toolName];
  if (!rule) {
    return trimmed.length > 400;
  }
  if (rule.alwaysIfLines) {
    const lines = trimmed.split('\n').length;
    if (lines >= rule.alwaysIfLines) return true;
  }
  return trimmed.length >= rule.minChars;
}

export function buildPreview(text: string, maxLen = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}…`;
}

export function buildPointerCard(block: ActionBlock, opts?: { truncated?: boolean }): string {
  const path = block.files_touched[0];
  const pathLine = path ? ` path=${path}` : '';
  const lines =
    block.line_count > 0 ? ` lines=1-${block.line_count}` : '';
  const trunc = opts?.truncated
    ? `\nstored=truncated_in_tool_layer original_chars=${block.byte_size}`
    : '';

  return [
    `[action:${block.action_id}]`,
    `tool=${block.tool_name}${pathLine}${lines} chars=${block.byte_size} sha256=${block.result_hash}`,
    `preview="${buildPreview(block.result_text)}"`,
    `recall=recall_query(action_id="${block.action_id}")`,
  ].join('\n') + trunc;
}

/**
 * Replace prior-turn inline tool results with frozen pointer cards (once per message).
 * Called at the start of turn N to pointerize tool messages from turns < N.
 */
export interface PointerizeOptions {
  /** Tool messages from turns >= beforeTurn - keepInlineTurns stay inline. */
  keepInlineTurns?: number;
}

export function materializePriorTurnTools(
  messages: ChatMessage[],
  beforeTurn: number,
  opts?: PointerizeOptions,
): void {
  const keepInlineTurns = Math.max(0, opts?.keepInlineTurns ?? 0);
  const pointerizeBeforeTurn = beforeTurn - keepInlineTurns;

  for (const msg of messages) {
    if (msg.role !== 'tool' || msg.pointerized || !msg.action_id) {
      continue;
    }
    if (msg.turn === undefined || msg.turn >= pointerizeBeforeTurn) {
      continue;
    }

    const block = loadAction(msg.action_id);
    if (!block || !shouldPointerize(block.tool_name, block.result_text)) {
      continue;
    }

    const truncated = (msg.content ?? '').includes('...(truncated)');
    msg.content = buildPointerCard(block, { truncated });
    msg.pointerized = true;
    block.pointerized = true;
  }
}