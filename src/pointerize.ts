import { attachActionPreview, DEFAULT_PREVIEW_POLICY, type PreviewPolicy } from './action-preview.js';
import { loadAction } from './action-store.js';
import type { ActionBlock, ChatMessage } from './types.js';

export const POINTER_RULES: Record<
  string,
  { minChars: number; alwaysIfLines?: number }
> = {
  read_file: { minChars: 600, alwaysIfLines: 40 },
  run_shell: { minChars: 800, alwaysIfLines: 30 },
  write_file: { minChars: Number.POSITIVE_INFINITY },
  edit_file: { minChars: Number.POSITIVE_INFINITY },
  grep_search: { minChars: 500, alwaysIfLines: 20 },
  list_files: { minChars: 500, alwaysIfLines: 30 },
  diff_file: { minChars: 600, alwaysIfLines: 30 },
  recall_query: { minChars: 600, alwaysIfLines: 30 },
  web_fetch: { minChars: 800, alwaysIfLines: 40 },
  web_search: { minChars: 600, alwaysIfLines: 25 },
};

const NEVER_POINTERIZE_PREFIXES = ['error:', 'ok: wrote', 'ok: edited'];

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

/** @deprecated Use buildPointerCard; kept for tests. */
export function buildPreview(text: string, maxLen = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}…`;
}

export function buildPointerCard(
  block: ActionBlock,
  opts?: { truncated?: boolean; previewPolicy?: PreviewPolicy },
): string {
  const policy = opts?.previewPolicy ?? DEFAULT_PREVIEW_POLICY;
  const enriched = attachActionPreview({ ...block }, policy);

  const path = block.files_touched[0];
  const pathLine = path ? ` path=${path}` : '';
  const lineRange =
    block.line_count > 0 ? ` lines=1-${block.line_count}` : '';
  const trunc = opts?.truncated
    ? `\nstored=truncated_in_tool_layer original_chars=${block.byte_size}`
    : '';

  const cardLines = [
    `[action:${block.action_id}]`,
    `tool=${block.tool_name}${pathLine}${lineRange} chars=${block.byte_size} sha256=${block.result_hash}`,
  ];

  if (enriched.preview_summary) {
    cardLines.push(`summary=${enriched.preview_summary}`);
  }

  if (enriched.preview_lines && enriched.preview_lines.length > 0) {
    cardLines.push('preview:');
    for (const line of enriched.preview_lines) {
      cardLines.push(`  ${line}`);
    }
  }

  cardLines.push(`recall=recall_query(action_id="${block.action_id}")`);

  return cardLines.join('\n') + trunc;
}

export interface PointerizeOptions {
  /** Tool messages from turns >= beforeTurn - keepInlineTurns stay inline. */
  keepInlineTurns?: number;
  previewPolicy?: PreviewPolicy;
}

export function materializePriorTurnTools(
  messages: ChatMessage[],
  beforeTurn: number,
  opts?: PointerizeOptions,
): void {
  const keepInlineTurns = Math.max(0, opts?.keepInlineTurns ?? 0);
  const pointerizeBeforeTurn = beforeTurn - keepInlineTurns;
  const previewPolicy = opts?.previewPolicy ?? DEFAULT_PREVIEW_POLICY;

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
    msg.content = buildPointerCard(block, { truncated, previewPolicy });
    msg.pointerized = true;
    block.pointerized = true;
  }
}