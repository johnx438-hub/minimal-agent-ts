import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export interface WorkflowMeta {
  name: string;
  roles: string[];
  shareSession: boolean;
}

export function listWorkflowMetaForCwd(cwd: string): WorkflowMeta[] {
  const dir = resolve(cwd, 'workflows');
  if (!existsSync(dir)) return [];

  const metas: WorkflowMeta[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const fallbackName = basename(file, '.json');
    const path = resolve(dir, file);
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        name?: string;
        share_session?: boolean;
        roles?: Record<string, unknown>;
      };
      const roles =
        raw.roles && typeof raw.roles === 'object' ? Object.keys(raw.roles) : [];
      metas.push({
        name: raw.name?.trim() || fallbackName,
        roles,
        shareSession: raw.share_session === true,
      });
    } catch {
      metas.push({ name: fallbackName, roles: [], shareSession: false });
    }
  }
  metas.sort((a, b) => a.name.localeCompare(b.name));
  return metas;
}