import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { listSpawnActions } from '../action-store.js';
import { spawnRunsPath, spawnRunsDir } from '../workspace.js';

export function isSpawnSessionId(sessionId: string): boolean {
  return sessionId.startsWith('spawn_');
}

/** Virtual session id for one spawn_agent invocation. */
export function buildSpawnSessionId(parentSessionId: string): string {
  const parentTag = parentSessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-12) || 'root';
  const suffix = Date.now().toString(36);
  return `spawn_${parentTag}_${suffix}`;
}

export interface SpawnRunRecord {
  spawn_session_id: string;
  parent_session_id: string;
  preset: string;
  task: string;
  started_at: number;
  ended_at: number;
  ok: boolean;
  detail?: string;
}

function ensureSpawnRunsDir(parentSessionId: string): void {
  const dir = spawnRunsDir(parentSessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function appendSpawnRunRecord(record: SpawnRunRecord): void {
  ensureSpawnRunsDir(record.parent_session_id);
  appendFileSync(spawnRunsPath(record.parent_session_id), `${JSON.stringify(record)}\n`, 'utf8');
}

function readSpawnRunLines(parentSessionId: string): string[] {
  const path = spawnRunsPath(parentSessionId);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function listSpawnRunRecords(parentSessionId: string): SpawnRunRecord[] {
  const records: SpawnRunRecord[] = [];
  for (const line of readSpawnRunLines(parentSessionId)) {
    try {
      const parsed = JSON.parse(line) as SpawnRunRecord;
      if (parsed.parent_session_id === parentSessionId) {
        records.push(parsed);
      }
    } catch {
      /* skip malformed */
    }
  }
  return records.sort((a, b) => b.started_at - a.started_at);
}

export function countSpawnActions(
  parentSessionId: string,
  spawnSessionId: string,
): number {
  return listSpawnActions(parentSessionId, spawnSessionId).length;
}

export const SPAWN_LOG_TASK_PREFIX = '__spawn__:';

export function spawnLogTaskId(spawnSessionId: string): string {
  return `${SPAWN_LOG_TASK_PREFIX}${spawnSessionId}`;
}

export function parseSpawnLogTaskId(taskId: string): string | null {
  if (!taskId.startsWith(SPAWN_LOG_TASK_PREFIX)) return null;
  return taskId.slice(SPAWN_LOG_TASK_PREFIX.length) || null;
}