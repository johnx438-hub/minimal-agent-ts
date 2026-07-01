import * as readline from 'node:readline';

import type { PermissionChoice, PermissionRequest } from '../permission-gate.js';
import type { WorkflowCheckpointInfo } from '../workflow-checkpoint.js';
import { formatWorkflowCheckpoint } from '../workflow-checkpoint.js';

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function createPermissionPrompter(): (req: PermissionRequest) => Promise<PermissionChoice> {
  return async (req) => {
    const label = req.kind === 'shell' ? 'run_shell' : 'web_fetch';
    console.log(`\n⚠ ${label} requested (${req.reason}) but ${req.kind} is OFF`);
    console.log('  [y] session  [o] once for this run  [n] deny');
    const answer = await promptLine('› approve ');
    const a = answer.trim().toLowerCase();
    if (a === 'y' || a === 'yes' || a === 's' || a === 'session') return 'session';
    if (a === 'o' || a === 'once' || a === '1') return 'once';
    return 'deny';
  };
}

export function createWorkflowConfirm(): (info: WorkflowCheckpointInfo) => Promise<boolean> {
  return async (info) => {
    console.log(`\n${formatWorkflowCheckpoint(info)}`);
    const answer = await promptLine('› run workflow? [y/N] ');
    const a = answer.trim().toLowerCase();
    return a === 'y' || a === 'yes';
  };
}