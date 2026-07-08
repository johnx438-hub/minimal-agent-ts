import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { listActions, loadAction } from './action-store.js';
import type { ActionBlock, AgentConfig, RecallResult } from './types.js';

export type RecallFormat = 'full' | 'head_tail' | 'grep';
export type RecallScope = 'action' | 'task' | 'session';

export interface RecallQueryParams {
  query?: string;
  action_id?: string;
  task_id?: string;
  scope?: RecallScope;
  offset?: number;
  limit?: number;
  format?: RecallFormat;
}

const HEAD_TAIL_FULL_MAX = 2000;
const HEAD_CHARS = 800;
const TAIL_CHARS = 200;
const DEFAULT_AUTO_FULL_MAX_CHARS = 24_000;

export function resolveRecallFormat(
  params: RecallQueryParams,
  block: ActionBlock | null,
  autoFullMaxChars: number,
): RecallFormat {
  if (params.format) return params.format;
  if (params.offset !== undefined || params.limit !== undefined) {
    return 'full';
  }
  if (
    params.action_id &&
    block &&
    block.result_text.length <= autoFullMaxChars
  ) {
    return 'full';
  }
  return 'head_tail';
}

export async function isActionStale(block: ActionBlock, cwd: string): Promise<boolean> {
  if (block.files_touched.length === 0) return false;

  for (const rel of block.files_touched) {
    try {
      const full = isAbsolute(rel) ? rel : resolve(cwd, rel);
      const st = await stat(full);
      if (st.mtimeMs > block.timestamp) return true;
    } catch {
      // missing file — treat as changed
      return true;
    }
  }
  return false;
}

export function sliceLines(
  text: string,
  offset?: number,
  limit?: number,
): { content: string; has_more: boolean; total_lines: number; hint?: string } {
  const lines = text.split('\n');
  const total = lines.length;

  if (offset === undefined && limit === undefined) {
    return { content: text, has_more: false, total_lines: total };
  }

  const start = Math.max(0, (offset ?? 1) - 1);
  const end = limit === undefined ? lines.length : start + limit;
  const slice = lines.slice(start, end);
  const has_more = end < lines.length;

  return {
    content: slice.join('\n'),
    has_more,
    total_lines: total,
    hint: has_more ? `use offset=${end + 1} limit=${limit ?? 200} for more` : undefined,
  };
}

export function applyHeadTail(text: string): { content: string; has_more: boolean; hint?: string } {
  if (text.length <= HEAD_TAIL_FULL_MAX) {
    return { content: text, has_more: false };
  }

  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  return {
    content: `${head}\n…[${text.length - HEAD_CHARS - TAIL_CHARS} chars omitted — use offset/limit for more]…\n${tail}`,
    has_more: true,
    hint: 'use offset and limit for a specific line range, or format=full with small slices',
  };
}

export function grepInContent(text: string, query: string, maxLines = 40): string {
  const q = query.toLowerCase();
  const lines = text.split('\n');
  const hits: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(q)) {
      hits.push(`${i + 1}:${lines[i]}`);
      if (hits.length >= maxLines) break;
    }
  }

  return hits.length > 0 ? hits.join('\n') : '(no lines matched query)';
}

const KEYWORD_SCAN_MAX = 500;

function parseKeywordQuery(raw: string): { toolName?: string; terms: string } {
  const trimmed = raw.trim();
  const toolMatch = trimmed.match(/^tool:([^\s]+)\s*(.*)$/i);
  if (toolMatch) {
    return {
      toolName: toolMatch[1]!.toLowerCase(),
      terms: toolMatch[2]!.trim() || toolMatch[1]!,
    };
  }
  return { terms: trimmed };
}

function scoreAction(block: ActionBlock, terms: string): number {
  const q = terms.toLowerCase();
  if (!q) return 0;
  let score = 0;
  const hay = [
    block.tool_name,
    block.args_json,
    block.result_text.slice(0, 8000),
    ...block.files_touched,
  ].join('\n').toLowerCase();

  if (hay.includes(q)) score += 10;
  const tokens = q.split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (hay.includes(t)) score += 2;
  }
  return score;
}

function findBestActionByKeyword(
  candidates: ActionBlock[],
  query: string,
): ActionBlock | null {
  const { toolName, terms } = parseKeywordQuery(query);
  const scoped = toolName
    ? candidates.filter((b) => b.tool_name.toLowerCase() === toolName)
    : candidates;

  let best: ActionBlock | null = null;
  let bestScore = 0;
  for (const block of scoped.slice(0, KEYWORD_SCAN_MAX)) {
    const s = scoreAction(block, terms);
    if (s > bestScore) {
      bestScore = s;
      best = block;
    }
  }
  return bestScore > 0 ? best : null;
}

function throwIfAborted(config: AgentConfig): void {
  if (config.abortSignal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

async function resolveActionBlock(
  params: RecallQueryParams,
  config: AgentConfig,
): Promise<ActionBlock | null> {
  throwIfAborted(config);

  if (params.action_id) {
    const block = loadAction(params.action_id);
    if (!block) return null;
    if (config.sessionId && block.session_id !== config.sessionId) return null;
    return block;
  }

  const query = params.query?.trim();
  if (!query) return null;

  const scope = params.scope ?? 'session';
  const sessionId = scope === 'session' ? config.sessionId : undefined;
  const taskId = scope === 'task' || params.task_id ? params.task_id : undefined;

  let candidates = listActions(sessionId, taskId);
  if (scope === 'task' && params.task_id) {
    candidates = candidates.filter((b) => b.task_id === params.task_id);
  }

  throwIfAborted(config);
  return findBestActionByKeyword(candidates, query);
}

export async function recallQuery(
  params: RecallQueryParams,
  config: AgentConfig,
): Promise<RecallResult> {
  if (config.abortSignal?.aborted) {
    return {
      action_id: params.action_id ?? '',
      tool_name: '',
      matched: false,
      content: '[aborted]',
      total_chars: 0,
      has_more: false,
    };
  }

  const autoFullMaxChars =
    config.recallAutoFullMaxChars ?? DEFAULT_AUTO_FULL_MAX_CHARS;

  let block: ActionBlock | null;
  try {
    block = await resolveActionBlock(params, config);
  } catch (err) {
    if (
      (err instanceof DOMException && err.name === 'AbortError') ||
      config.abortSignal?.aborted
    ) {
      return {
        action_id: params.action_id ?? '',
        tool_name: '',
        matched: false,
        content: '[aborted]',
        total_chars: 0,
        has_more: false,
      };
    }
    throw err;
  }
  const format = resolveRecallFormat(params, block, autoFullMaxChars);

  if (!block) {
    return {
      action_id: params.action_id ?? '',
      tool_name: '',
      matched: false,
      content: params.action_id
        ? `error: action not found: ${params.action_id}`
        : 'error: no matching action for query (try action_id from [action:…] card)',
      total_chars: 0,
      has_more: false,
    };
  }

  const stale = await isActionStale(block, config.cwd);
  let text = block.result_text;
  let has_more = false;
  let hint: string | undefined;

  if (format === 'grep' && params.query) {
    text = grepInContent(text, params.query);
  } else if (params.offset !== undefined || params.limit !== undefined) {
    const sliced = sliceLines(text, params.offset, params.limit);
    text = sliced.content;
    has_more = sliced.has_more;
    hint = sliced.hint;
  } else if (format === 'full') {
    text = block.result_text;
    if (text.length > autoFullMaxChars) {
      has_more = true;
      hint = `full payload is ${text.length} chars; use offset=1 limit=200 (or smaller slices)`;
    }
  } else {
    const ht = applyHeadTail(text);
    text = ht.content;
    has_more = ht.has_more;
    hint = ht.hint;
  }

  if (stale) {
    hint = [hint, 'stale: source file changed since action; use read_file for latest'].filter(Boolean).join('; ');
  }

  return {
    action_id: block.action_id,
    tool_name: block.tool_name,
    matched: true,
    content: text,
    total_chars: block.result_text.length,
    has_more,
    stale: stale || undefined,
    hint,
  };
}

export function formatRecallResult(result: RecallResult): string {
  return JSON.stringify(result, null, 2);
}