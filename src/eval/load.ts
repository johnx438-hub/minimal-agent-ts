import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { EvalStrategyFile, EvalTaskMeta } from './types.js';

export function resolveEvalRoot(projectRoot: string, evalRoot?: string): string {
  return resolve(evalRoot ?? join(projectRoot, 'eval'));
}

export function loadStrategy(
  evalRoot: string,
  strategyId: string,
): EvalStrategyFile {
  const path = join(evalRoot, 'strategies', `${strategyId}.json`);
  if (!existsSync(path)) {
    throw new Error(`strategy not found: ${strategyId} (${path})`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as EvalStrategyFile;
}

export function loadTaskMeta(evalRoot: string, taskId: string): EvalTaskMeta {
  const path = join(evalRoot, 'tasks', taskId, 'meta.json');
  if (!existsSync(path)) {
    throw new Error(`task meta not found: ${taskId} (${path})`);
  }
  const meta = JSON.parse(readFileSync(path, 'utf8')) as EvalTaskMeta;
  if (!meta.id) meta.id = taskId;
  return meta;
}

export function taskDir(evalRoot: string, taskId: string): string {
  return join(evalRoot, 'tasks', taskId);
}

export function readTaskPrompt(evalRoot: string, taskId: string): string {
  const path = join(taskDir(evalRoot, taskId), 'TASK.md');
  if (!existsSync(path)) {
    throw new Error(`TASK.md not found for ${taskId}`);
  }
  return readFileSync(path, 'utf8');
}

export function gitSha(projectRoot: string): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    if (r.status === 0 && r.stdout?.trim()) return r.stdout.trim();
  } catch {
    /* ignore */
  }
  return null;
}
