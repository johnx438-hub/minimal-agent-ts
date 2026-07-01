import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ActionBlock } from './types.js';
import { actionsDir, ensureSessionsDir } from './workspace.js';

export function getActionsDir(): string {
  return actionsDir();
}

export function getActionPath(actionId: string): string {
  return resolve(actionsDir(), `${actionId}.json`);
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
  };
}

export function saveAction(block: ActionBlock): void {
  ensureSessionsDir();
  const dir = actionsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getActionPath(block.action_id), JSON.stringify(block, null, 2), 'utf8');
}

export function loadAction(actionId: string): ActionBlock | null {
  const path = getActionPath(actionId);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ActionBlock;
  } catch {
    return null;
  }
}

/** List actions from cold storage, newest first. */
export function listActions(sessionId?: string, taskId?: string): ActionBlock[] {
  const dir = actionsDir();
  if (!existsSync(dir)) {
    return [];
  }

  const blocks: ActionBlock[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const block = loadAction(entry.replace(/\.json$/, ''));
    if (!block) continue;
    if (sessionId && block.session_id !== sessionId) continue;
    if (taskId && block.task_id !== taskId) continue;
    blocks.push(block);
  }

  blocks.sort((a, b) => b.timestamp - a.timestamp);
  return blocks;
}