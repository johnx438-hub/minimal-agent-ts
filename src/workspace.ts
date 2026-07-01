import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

let workspaceRoot = resolve(process.cwd());

/** Active project root — session/action storage lives under `<root>/.sessions`. */
export function getWorkspaceRoot(): string {
  return workspaceRoot;
}

export function setWorkspaceRoot(cwd: string): void {
  workspaceRoot = resolve(cwd);
  ensureSessionsDir();
}

export function sessionsDir(): string {
  return resolve(workspaceRoot, '.sessions');
}

export function ensureSessionsDir(): void {
  const dir = sessionsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function sessionPath(sessionId: string): string {
  return resolve(sessionsDir(), `${sessionId}.json`);
}

export function actionsDir(): string {
  return resolve(sessionsDir(), 'actions');
}

export function agentMemoryDir(): string {
  return resolve(sessionsDir(), 'agent_memory');
}

export function handoffPath(sessionId: string): string {
  return resolve(sessionsDir(), `handoff_${sessionId}.md`);
}