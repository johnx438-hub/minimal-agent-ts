import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { ResolvedWorkflowRole, WorkflowRoleConfig } from './types.js';

function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: raw.trim() };
  }

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    meta[key] = value;
  }

  return { meta, body: match[2].trim() };
}

function parseToolsList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function resolveRoleFilePath(workflowPath: string, promptFile: string): string {
  const base = dirname(workflowPath);
  return isAbsolute(promptFile) ? promptFile : resolve(base, promptFile);
}

export function resolveWorkflowRole(
  roleName: string,
  config: WorkflowRoleConfig,
  workflowPath: string,
): ResolvedWorkflowRole {
  let body = config.prompt?.trim() ?? '';
  let tools = config.tools;
  let model = config.model;
  let apiProfile = config.api_profile;
  let maxTurns = config.max_turns;

  if (config.prompt_file) {
    const path = resolveRoleFilePath(workflowPath, config.prompt_file);
    if (!existsSync(path)) {
      throw new Error(`Role prompt file not found: ${path}`);
    }
    const raw = readFileSync(path, 'utf8');
    const { meta, body: mdBody } = parseFrontmatter(raw);
    if (mdBody) body = mdBody;
    tools = tools ?? parseToolsList(meta.tools);
    model = model ?? meta.model;
    apiProfile = apiProfile ?? meta.api_profile;
    if (maxTurns === undefined && meta.max_turns) {
      maxTurns = Number(meta.max_turns);
    }
  }

  if (!body) {
    body = `You are the "${roleName}" role in a multi-step workflow. Complete your part and reply clearly.`;
  }

  const toolLine =
    tools && tools.length > 0
      ? `\n\nAllowed tools for this role: ${tools.join(', ')}.`
      : '';

  return {
    name: roleName,
    systemPrompt: `${body}${toolLine}`,
    tools: tools ?? [],
    model,
    api_profile: apiProfile,
    maxTurns,
  };
}