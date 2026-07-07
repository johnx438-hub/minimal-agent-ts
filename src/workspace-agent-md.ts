import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

/** Filenames tried in order under workspace cwd. */
export const WORKSPACE_AGENT_MD_FILENAMES = ['Agent.md', 'AGENTS.md'] as const;

export const DEFAULT_WORKSPACE_AGENT_MD_MAX_CHARS = 8_000;

export interface WorkspaceAgentMd {
  /** Absolute path to the loaded file. */
  path: string;
  /** Path relative to cwd for display. */
  relativePath: string;
  content: string;
  truncated: boolean;
}

export interface LoadWorkspaceAgentMdOptions {
  maxChars?: number;
}

function normalizeCwd(cwd: string): string {
  return resolve(cwd);
}

function resolveFileInCwd(cwd: string, filename: string): string | null {
  const root = normalizeCwd(cwd);
  const candidate = resolve(root, filename);
  if (!candidate.startsWith(root)) return null;
  if (!existsSync(candidate)) return null;
  return candidate;
}

/** First existing Agent.md / AGENTS.md under cwd, or null. */
export function findWorkspaceAgentMdPath(cwd: string): string | null {
  for (const name of WORKSPACE_AGENT_MD_FILENAMES) {
    const path = resolveFileInCwd(cwd, name);
    if (path) return path;
  }
  return null;
}

export function loadWorkspaceAgentMd(
  cwd: string,
  opts?: LoadWorkspaceAgentMdOptions,
): WorkspaceAgentMd | null {
  const path = findWorkspaceAgentMdPath(cwd);
  if (!path) return null;

  const maxChars =
    opts?.maxChars ??
    (process.env.AGENT_MD_MAX_CHARS
      ? Number(process.env.AGENT_MD_MAX_CHARS)
      : DEFAULT_WORKSPACE_AGENT_MD_MAX_CHARS);

  const limit =
    Number.isFinite(maxChars) && maxChars > 0
      ? maxChars
      : DEFAULT_WORKSPACE_AGENT_MD_MAX_CHARS;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
  if (!raw) return null;

  const truncated = raw.length > limit;
  const content = truncated ? raw.slice(0, limit) : raw;
  const root = normalizeCwd(cwd);
  const relativePath = path.startsWith(`${root}/`)
    ? path.slice(root.length + 1)
    : basename(path);

  return { path, relativePath, content, truncated };
}

export function formatWorkspaceAgentMdBlock(doc: WorkspaceAgentMd): string {
  const truncNote = doc.truncated ? '\n\n_(Workspace agent instructions truncated.)_' : '';
  return `\n\n## Workspace agent instructions\nSource: ${doc.relativePath}\n\n${doc.content}${truncNote}`;
}

export function workspaceAgentMdRunMeta(doc: WorkspaceAgentMd): string {
  const chars = doc.content.length;
  const trunc = doc.truncated ? ', truncated' : '';
  return `📋 ${doc.relativePath} (${chars} chars${trunc})`;
}