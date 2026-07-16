/**
 * SW-6: import project-local `<cwd>/.sessions` into agent_home by-project buckets.
 * SPEC_SESSION_WORKSPACE §10 P2 / SW-6.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { SessionFile } from './types.js';
import {
  defaultPrimaryGrant,
  getAgentHome,
  projectIdFromRoot,
  type SessionWorkspaceState,
} from './workspace.js';

export interface ImportProjectLocalSessionsOptions {
  /** Project root that owns `.sessions` (default: process workspace primary later). */
  projectRoot: string;
  /** Override agent home (default getAgentHome()). */
  agentHome?: string;
  /** Overwrite existing session_*.json in dest (default false → skip). */
  overwrite?: boolean;
  /** Copy actions/spawn/<session_id> trees when present (default true). */
  copySpawnArtifacts?: boolean;
}

export interface ImportProjectLocalSessionsResult {
  project_root: string;
  project_id: string;
  source_dir: string;
  dest_dir: string;
  imported: string[];
  skipped: string[];
  errors: Array<{ file: string; error: string }>;
  /** Sidecar files copied (transcript/handoff/spawn dirs). */
  sidecars: number;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function stampWorkspace(
  session: SessionFile,
  projectRoot: string,
  projectId: string,
): SessionFile {
  const root = resolve(projectRoot);
  const ws: SessionWorkspaceState = session.workspace ?? {
    project_id: projectId,
    primary_root: root,
    active_cwd: root,
    workspace_grants: [defaultPrimaryGrant(root)],
  };
  return {
    ...session,
    workspace: {
      ...ws,
      project_id: projectId,
      primary_root: root,
      active_cwd: ws.active_cwd ? resolve(ws.active_cwd) : root,
      workspace_grants:
        ws.workspace_grants?.length > 0
          ? ws.workspace_grants
          : [defaultPrimaryGrant(root)],
    },
  };
}

function copyIfExists(src: string, dest: string): boolean {
  if (!existsSync(src)) return false;
  ensureDir(resolve(dest, '..'));
  const st = statSync(src);
  if (st.isDirectory()) {
    cpSync(src, dest, { recursive: true, force: true });
  } else {
    copyFileSync(src, dest);
  }
  return true;
}

/**
 * Copy session JSON (+ transcript/handoff/spawn artifacts) from
 * `<projectRoot>/.sessions` into
 * `<agentHome>/sessions/by-project/<project_id>/`.
 *
 * Does not delete source files. Does not switch session_store mode.
 */
export function importProjectLocalSessions(
  opts: ImportProjectLocalSessionsOptions,
): ImportProjectLocalSessionsResult {
  const projectRoot = resolve(opts.projectRoot);
  const agentHome = resolve(opts.agentHome ?? getAgentHome());
  const projectId = projectIdFromRoot(projectRoot);
  const sourceDir = join(projectRoot, '.sessions');
  const destDir = join(agentHome, 'sessions', 'by-project', projectId);
  const overwrite = opts.overwrite === true;
  const copySpawn = opts.copySpawnArtifacts !== false;

  const result: ImportProjectLocalSessionsResult = {
    project_root: projectRoot,
    project_id: projectId,
    source_dir: sourceDir,
    dest_dir: destDir,
    imported: [],
    skipped: [],
    errors: [],
    sidecars: 0,
  };

  if (!existsSync(sourceDir)) {
    result.errors.push({
      file: sourceDir,
      error: 'source .sessions directory not found',
    });
    return result;
  }

  ensureDir(destDir);

  const entries = readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    if (!entry.name.startsWith('session_')) continue;

    const srcPath = join(sourceDir, entry.name);
    const destPath = join(destDir, entry.name);
    const sessionId = entry.name.replace(/\.json$/, '');

    try {
      if (existsSync(destPath) && !overwrite) {
        result.skipped.push(sessionId);
        continue;
      }

      const raw = readFileSync(srcPath, 'utf8');
      const parsed = JSON.parse(raw) as SessionFile;
      if (!parsed.session_id) {
        result.errors.push({ file: entry.name, error: 'missing session_id' });
        continue;
      }

      const stamped = stampWorkspace(parsed, projectRoot, projectId);
      writeFileSync(destPath, `${JSON.stringify(stamped, null, 2)}\n`, 'utf8');
      result.imported.push(parsed.session_id);

      // Sidecars next to session json
      if (
        copyIfExists(
          join(sourceDir, `transcript_${parsed.session_id}.jsonl`),
          join(destDir, `transcript_${parsed.session_id}.jsonl`),
        )
      ) {
        result.sidecars += 1;
      }
      if (
        copyIfExists(
          join(sourceDir, `handoff_${parsed.session_id}.md`),
          join(destDir, `handoff_${parsed.session_id}.md`),
        )
      ) {
        result.sidecars += 1;
      }

      if (copySpawn) {
        const spawnSrc = join(sourceDir, 'spawn', parsed.session_id);
        const spawnDest = join(destDir, 'spawn', parsed.session_id);
        if (copyIfExists(spawnSrc, spawnDest)) result.sidecars += 1;

        const actionsSpawnSrc = join(
          sourceDir,
          'actions',
          'spawn',
          parsed.session_id,
        );
        const actionsSpawnDest = join(
          destDir,
          'actions',
          'spawn',
          parsed.session_id,
        );
        if (copyIfExists(actionsSpawnSrc, actionsSpawnDest)) {
          result.sidecars += 1;
        }
      }
    } catch (err) {
      result.errors.push({
        file: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

export function formatImportResult(r: ImportProjectLocalSessionsResult): string {
  const lines = [
    `import project-local sessions → agent_home`,
    `project: ${basename(r.project_root)} (${r.project_id})`,
    `from: ${r.source_dir}`,
    `to:   ${r.dest_dir}`,
    `imported: ${r.imported.length}`,
    `skipped:  ${r.skipped.length} (already exists; use overwrite to replace)`,
    `sidecars: ${r.sidecars}`,
  ];
  if (r.imported.length) {
    lines.push(`  + ${r.imported.slice(0, 8).join(', ')}${r.imported.length > 8 ? '…' : ''}`);
  }
  if (r.errors.length) {
    lines.push(`errors: ${r.errors.length}`);
    for (const e of r.errors.slice(0, 5)) {
      lines.push(`  ! ${e.file}: ${e.error}`);
    }
  }
  lines.push(
    'Note: does not change session_store mode. Set "session_store": "agent_home" to read from dest.',
  );
  return lines.join('\n');
}
