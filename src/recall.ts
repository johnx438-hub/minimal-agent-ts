import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { searchActions } from './action-index.js';
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

function scoreAction(block: ActionBlock, query: string): number {
  const q = query.toLowerCase();
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

async function resolveActionBlock(
  params: RecallQueryParams,
  config: AgentConfig,
): Promise<ActionBlock | null> {
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

  const indexedIds = await searchActions({
    query,
    sessionId,
    taskId,
    topk: 5,
  });

  for (const id of indexedIds) {
    const block = loadAction(id);
    if (block) return block;
  }

  // Fallback: keyword scan of cold storage when index miss / disabled
  let candidates = listActions(sessionId, taskId);
  if (scope === 'task' && params.task_id) {
    candidates = candidates.filter((b) => b.task_id === params.task_id);
  }

  let best: ActionBlock | null = null;
  let bestScore = 0;
  for (const block of candidates) {
    const s = scoreAction(block, query);
    if (s > bestScore) {
      bestScore = s;
      best = block;
    }
  }

  return bestScore > 0 ? best : null;
}

export async function recallQuery(
  params: RecallQueryParams,
  config: AgentConfig,
): Promise<RecallResult> {
  const format: RecallFormat = params.format ?? 'head_tail';
  const block = await resolveActionBlock(params, config);

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
    if (params.offset !== undefined || params.limit !== undefined) {
      const sliced = sliceLines(text, params.offset, params.limit);
      text = sliced.content;
      has_more = sliced.has_more;
      hint = sliced.hint;
    } else {
      text = block.result_text;
      has_more = false;
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