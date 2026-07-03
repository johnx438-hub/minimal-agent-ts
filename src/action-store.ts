import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveActionFilePath } from './action-paths.js';
export { actionFilePathForBlock, ensureSpawnActionsDir } from './action-paths.js';
import { recordActionSave } from './action-io-metrics.js';
import { getActionWriteQueue } from './action-write-queue.js';
import type { ActionBlock } from './types.js';
import { actionsDir, spawnActionsDir } from './workspace.js';

export function getActionsDir(): string {
  return actionsDir();
}

function loadActionFromPath(path: string): ActionBlock | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ActionBlock;
  } catch {
    return null;
  }
}

export function getActionPath(actionId: string): string {
  return resolveActionFilePath(actionId);
}

export function hashResult(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function extractPathsFromArgs(argsJson: string): string[] {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const paths: string[] = [];
    if (typeof args.path === 'string') paths.push(args.path);
    return paths;
  } catch {
    return [];
  }
}

export function buildActionBlock(input: {
  action_id: string;
  task_id: string;
  session_id: string;
  turn_number: number;
  tool_name: string;
  args_json: string;
  result_text: string;
  pointerized?: boolean;
  spawn_parent_session_id?: string;
}): ActionBlock {
  const lines = input.result_text.split('\n');
  return {
    action_id: input.action_id,
    task_id: input.task_id,
    session_id: input.session_id,
    turn_number: input.turn_number,
    tool_name: input.tool_name,
    args_json: input.args_json,
    result_text: input.result_text,
    result_hash: hashResult(input.result_text),
    byte_size: Buffer.byteLength(input.result_text, 'utf8'),
    line_count: lines.length,
    pointerized: input.pointerized ?? false,
    files_touched: extractPathsFromArgs(input.args_json),
    timestamp: Date.now(),
    token_cost: Math.ceil(input.result_text.split(/\s+/).filter(Boolean).length * 1.3),
    spawn_parent_session_id: input.spawn_parent_session_id,
  };
}

export function saveAction(block: ActionBlock): void {
  const durationMs = getActionWriteQueue().enqueue(block);
  recordActionSave(durationMs);
}

export function loadAction(actionId: string): ActionBlock | null {
  return loadActionFromPath(getActionPath(actionId));
}

function collectActionFiles(dir: string): ActionBlock[] {
  if (!existsSync(dir)) return [];

  const blocks: ActionBlock[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const block = loadActionFromPath(resolve(dir, entry));
    if (block) blocks.push(block);
  }
  return blocks;
}

/** List spawn actions for a parent session, newest first. */
export function listSpawnActions(
  parentSessionId: string,
  spawnSessionId?: string,
): ActionBlock[] {
  const blocks = collectActionFiles(spawnActionsDir(parentSessionId));
  const filtered = spawnSessionId
    ? blocks.filter((b) => b.session_id === spawnSessionId)
    : blocks;
  filtered.sort((a, b) => b.timestamp - a.timestamp);
  return filtered;
}

/** List actions from cold storage, newest first. */
export function listActions(sessionId?: string, taskId?: string): ActionBlock[] {
  const blocks = collectActionFiles(actionsDir());

  const filtered = blocks.filter((block) => {
    if (sessionId && block.session_id !== sessionId) return false;
    if (taskId && block.task_id !== taskId) return false;
    return true;
  });

  filtered.sort((a, b) => b.timestamp - a.timestamp);
  return filtered;
}