import * as readline from 'node:readline';

import type { PermissionChoice, PermissionRequest } from '../permission-gate.js';
import type { WorkflowCheckpointInfo } from '../workflow-checkpoint.js';
import { formatWorkflowCheckpoint } from '../workflow-checkpoint.js';

function promptLine(question: string, signal?: AbortSignal): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: string): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      rl.close();
      resolve(answer);
    };

    const onAbort = (): void => finish('');
    if (signal?.aborted) {
      finish('');
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    rl.question(question, (answer) => finish(answer));
  });
}

export function createPermissionPrompter(): (req: PermissionRequest) => Promise<PermissionChoice> {
  return async (req) => {
    const title =
      req.kind === 'path_escape'
        ? `⚠ path outside cwd (${req.reason})`
        : `⚠ ${req.kind === 'shell' ? 'run_shell' : 'web_fetch'} requested (${req.reason}) but ${req.kind} is OFF`;
    console.log(`\n${title}`);
    console.log('  [y] session  [o] once for this run  [n] deny');
    const answer = await promptLine('› approve ', req.abortSignal);
    if (req.abortSignal?.aborted) return 'deny';
    const a = answer.trim().toLowerCase();
    if (a === 'y' || a === 'yes' || a === 's' || a === 'session') return 'session';
    if (a === 'o' || a === 'once' || a === '1') return 'once';
    return 'deny';
  };
}

export function createCwdChangeConfirm(): (
  fromCwd: string,
  toPath: string,
  signal?: AbortSignal,
) => Promise<boolean> {
  return async (fromCwd, toPath, signal) => {
    if (signal?.aborted) return false;
    console.log(`\n⚠ Change cwd outside current tree?`);
    console.log(`  from: ${fromCwd}`);
    console.log(`  to:   ${toPath}`);
    const answer = await promptLine('› change cwd? [y/N] ', signal);
    if (signal?.aborted) return false;
    const a = answer.trim().toLowerCase();
    return a === 'y' || a === 'yes';
  };
}

export function createWorkflowConfirm(): (
  info: WorkflowCheckpointInfo,
  signal?: AbortSignal,
) => Promise<boolean> {
  return async (info, signal) => {
    if (signal?.aborted) return false;
    console.log(`\n${formatWorkflowCheckpoint(info)}`);
    const answer = await promptLine('› run workflow? [y/N] ', signal);
    if (signal?.aborted) return false;
    const a = answer.trim().toLowerCase();
    return a === 'y' || a === 'yes';
  };
}