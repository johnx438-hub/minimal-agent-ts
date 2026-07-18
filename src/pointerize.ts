import { attachActionPreview, DEFAULT_PREVIEW_POLICY, type PreviewPolicy } from './action-preview.js';
import { loadAction } from './action-store.js';
import type {
  PointerizeMode,
  PointerizePolicy,
  PointerizeToolOverride,
} from './plugins/types.js';
import type { ActionBlock, ChatMessage } from './types.js';
import {
  estimateTokens,
  usableContextTokens,
  type BudgetConfig,
} from './context/budget.js';

export const POINTER_RULES: Record<
  string,
  { minChars: number; alwaysIfLines?: number }
> = {
  read_file: { minChars: 600, alwaysIfLines: 40 },
  run_shell: { minChars: 800, alwaysIfLines: 30 },
  test_run: { minChars: 1200, alwaysIfLines: 50 },
  git_status: { minChars: 800, alwaysIfLines: 40 },
  git_diff: { minChars: 800, alwaysIfLines: 40 },
  git_log: { minChars: 600, alwaysIfLines: 30 },
  lsp_query: { minChars: 900, alwaysIfLines: 40 },
  write_file: { minChars: Number.POSITIVE_INFINITY },
  edit_file: { minChars: Number.POSITIVE_INFINITY },
  apply_patch: { minChars: Number.POSITIVE_INFINITY },
  /** Skill bodies are operational recipes; keep full text across turns. */
  invoke_skill: { minChars: Number.POSITIVE_INFINITY },
  grep_search: { minChars: 500, alwaysIfLines: 20 },
  list_files: { minChars: 500, alwaysIfLines: 30 },
  diff_file: { minChars: 600, alwaysIfLines: 30 },
  /**
   * Recall is the recovery path after cards; pointerizing it causes review death-spirals
   * (SPEC_POINTERIZE_SCOPE). Override via tool_overrides if needed.
   */
  recall_query: { minChars: Number.POSITIVE_INFINITY },
  web_fetch: { minChars: 800, alwaysIfLines: 40 },
  web_search: { minChars: 600, alwaysIfLines: 25 },
};

const NEVER_POINTERIZE_PREFIXES = ['error:', 'ok: wrote', 'ok: edited'];

export function resolveToolOverride(
  toolName: string,
  policy?: PointerizePolicy | null,
): PointerizeToolOverride | undefined {
  return policy?.tool_overrides?.[toolName];
}

export function shouldPointerize(
  toolName: string,
  raw: string,
  policy?: PointerizePolicy | null,
): boolean {
  const override = resolveToolOverride(toolName, policy);
  if (override?.mode === 'never') return false;

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

/** Effective keep window for a tool (override or global). */
export function resolveKeepInlineTurnsForTool(
  toolName: string,
  globalKeep: number,
  policy?: PointerizePolicy | null,
  focus?: {
    keepInlineTurns: number;
    remainingTurns: number;
    tools?: string[];
  } | null,
): number {
  let keep = Math.max(0, globalKeep);
  const override = resolveToolOverride(toolName, policy);
  if (
    override?.keep_inline_turns !== undefined &&
    Number.isFinite(override.keep_inline_turns)
  ) {
    keep = Math.max(0, Math.floor(override.keep_inline_turns));
  }
  if (
    focus &&
    focus.remainingTurns > 0 &&
    Number.isFinite(focus.keepInlineTurns) &&
    (!focus.tools?.length || focus.tools.includes(toolName))
  ) {
    keep = Math.max(keep, Math.max(0, Math.floor(focus.keepInlineTurns)));
  }
  return keep;
}

export const DEFAULT_SOFT_FORCE_RATIO = 0.75;

/** True when context is high enough to force pointerize despite hold/focus. */
export function shouldForcePointerize(
  messages: ChatMessage[],
  budget: BudgetConfig | undefined,
  policy?: PointerizePolicy | null,
): boolean {
  if (!budget) return false;
  const ratio =
    policy?.soft_force_ratio !== undefined &&
    Number.isFinite(policy.soft_force_ratio)
      ? Math.min(0.95, Math.max(0.5, policy.soft_force_ratio))
      : DEFAULT_SOFT_FORCE_RATIO;
  const usable = usableContextTokens(budget);
  if (usable <= 0) return false;
  return estimateTokens(messages) > usable * ratio;
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
  /** Full policy including tool_overrides (SPEC_POINTERIZE_SCOPE). */
  pointerizePolicy?: PointerizePolicy | null;
  /** P2: hold skips pointerize unless force. */
  pointerizeMode?: PointerizeMode | null;
  /** P2: context_focus temporary boost. */
  pointerizeFocus?: {
    keepInlineTurns: number;
    remainingTurns: number;
    tools?: string[];
  } | null;
  /** Force window pointerize (budget pressure). */
  force?: boolean;
}

export function materializePriorTurnTools(
  messages: ChatMessage[],
  beforeTurn: number,
  opts?: PointerizeOptions,
): number {
  const mode = opts?.pointerizeMode ?? 'window';
  if (mode === 'hold' && !opts?.force) {
    return 0;
  }

  const globalKeep = Math.max(0, opts?.keepInlineTurns ?? 0);
  const pointerizePolicy = opts?.pointerizePolicy;
  const focus =
    opts?.force || !opts?.pointerizeFocus || opts.pointerizeFocus.remainingTurns <= 0
      ? null
      : opts.pointerizeFocus;
  const previewPolicy = opts?.previewPolicy ?? DEFAULT_PREVIEW_POLICY;
  let pointerized = 0;

  for (const msg of messages) {
    if (msg.role !== 'tool' || msg.pointerized || !msg.action_id) {
      continue;
    }
    if (msg.turn === undefined) {
      continue;
    }

    const block = loadAction(msg.action_id);
    if (!block) continue;

    const toolKeep = resolveKeepInlineTurnsForTool(
      block.tool_name,
      globalKeep,
      pointerizePolicy,
      focus,
    );
    const pointerizeBeforeTurn = beforeTurn - toolKeep;
    if (msg.turn >= pointerizeBeforeTurn) {
      continue;
    }

    if (!shouldPointerize(block.tool_name, block.result_text, pointerizePolicy)) {
      continue;
    }

    const body = typeof msg.content === 'string' ? msg.content : '';
    const truncated = body.includes('...(truncated)');
    msg.content = buildPointerCard(block, { truncated, previewPolicy });
    msg.pointerized = true;
    block.pointerized = true;
    pointerized++;
  }

  return pointerized;
}

/** Decrement context_focus remainingTurns after a pointerize stage. */
export function tickPointerizeFocus(focus: {
  remainingTurns: number;
} | null | undefined): boolean {
  if (!focus || focus.remainingTurns <= 0) return false;
  focus.remainingTurns -= 1;
  return focus.remainingTurns <= 0;
}
