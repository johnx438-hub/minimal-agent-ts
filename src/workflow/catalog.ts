import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export interface WorkflowMeta {
  name: string;
  roles: string[];
  shareSession: boolean;
  /** flow | dag */
  kind: 'flow' | 'dag';
  path: string;
}

export function listWorkflowMetaForCwd(
  cwd: string,
  dirs: string[] = ['workflows'],
): WorkflowMeta[] {
  const metas: WorkflowMeta[] = [];
  const seen = new Set<string>();

  for (const d of dirs) {
    const dir = resolve(cwd, d);
    if (!existsSync(dir)) continue;

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const fallbackName = basename(file, '.json');
      const path = resolve(dir, file);
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as {
          name?: string;
          share_session?: boolean;
          roles?: Record<string, unknown>;
          flow?: unknown[];
          nodes?: Record<string, unknown>;
          entry?: string;
        };
        const name = raw.name?.trim() || fallbackName;
        if (seen.has(name)) continue;
        seen.add(name);
        const roles =
          raw.roles && typeof raw.roles === 'object' ? Object.keys(raw.roles) : [];
        const kind: 'flow' | 'dag' =
          raw.nodes && raw.entry ? 'dag' : 'flow';
        metas.push({
          name,
          roles,
          shareSession: raw.share_session === true,
          kind,
          path,
        });
      } catch {
        if (seen.has(fallbackName)) continue;
        seen.add(fallbackName);
        metas.push({
          name: fallbackName,
          roles: [],
          shareSession: false,
          kind: 'flow',
          path,
        });
      }
    }
  }
  metas.sort((a, b) => a.name.localeCompare(b.name));
  return metas;
}