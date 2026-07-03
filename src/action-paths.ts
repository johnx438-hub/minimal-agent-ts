import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ActionBlock } from './types.js';
import { actionsDir, ensureSessionsDir, spawnActionsDir } from './workspace.js';

function ensureActionsDir(): void {
  ensureSessionsDir();
  const dir = actionsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function ensureSpawnActionsDir(parentSessionId: string): void {
  ensureActionsDir();
  const dir = spawnActionsDir(parentSessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function actionFilePathForBlock(block: ActionBlock): string {
  if (block.spawn_parent_session_id) {
    ensureSpawnActionsDir(block.spawn_parent_session_id);
    return resolve(spawnActionsDir(block.spawn_parent_session_id), `${block.action_id}.json`);
  }
  ensureActionsDir();
  return resolve(actionsDir(), `${block.action_id}.json`);
}

function findSpawnActionPath(actionId: string): string | null {
  const spawnRoot = resolve(actionsDir(), 'spawn');
  if (!existsSync(spawnRoot)) return null;

  for (const parentEntry of readdirSync(spawnRoot, { withFileTypes: true })) {
    if (!parentEntry.isDirectory()) continue;
    const candidate = resolve(spawnRoot, parentEntry.name, `${actionId}.json`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveActionFilePath(actionId: string): string {
  const flat = resolve(actionsDir(), `${actionId}.json`);
  if (existsSync(flat)) return flat;
  return findSpawnActionPath(actionId) ?? flat;
}