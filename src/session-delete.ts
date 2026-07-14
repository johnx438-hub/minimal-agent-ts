/**
 * Inventory and delete all on-disk artifacts bound to one main session.
 * Does not touch agent_memory, web/test caches, or shared code-review report paths.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { getActionPath, listActions } from './action-store.js';
import { jobDir, jobsDir } from './spawn/job-paths.js';
import {
  readJobIndex,
  readJobMeta,
  writeJobIndex,
  type SpawnJobMeta,
} from './spawn/job-store.js';
import { getJobRegistry, type JobCancelOutcome } from './spawn/job-registry.js';
import {
  actionsDir,
  handoffPath,
  sessionPath,
  sessionsDir,
  spawnActionsDir,
  spawnRunsDir,
  transcriptPath,
} from './workspace.js';

/** Main session ids only (matches generateSessionId). Rejects path traversal. */
export const SAFE_SESSION_ID_RE = /^session_[A-Za-z0-9_-]{1,80}$/;
/** Background job ids (matches newJobId). */
export const SAFE_JOB_ID_RE = /^job_[A-Za-z0-9_-]{1,80}$/;

export function isSafeSessionId(id: string): boolean {
  return SAFE_SESSION_ID_RE.test(id.trim());
}

export function isSafeJobId(id: string): boolean {
  return SAFE_JOB_ID_RE.test(id.trim());
}

/** True if resolved path is root or a strict descendant (no .. escape). */
export function isPathInsideRoot(root: string, candidate: string): boolean {
  const rootAbs = resolve(root);
  const candAbs = resolve(candidate);
  if (candAbs === rootAbs) return true;
  const rel = relative(rootAbs, candAbs);
  return rel !== '' && !rel.startsWith(`..${sep}`) && !rel.startsWith('..') && !rel.includes(`..${sep}`);
}

export interface SessionArtifacts {
  session_id: string;
  exists: boolean;
  session_path: string;
  session_bytes: number;
  handoff_path: string;
  handoff_exists: boolean;
  handoff_bytes: number;
  transcript_path: string;
  transcript_exists: boolean;
  transcript_bytes: number;
  flat_action_ids: string[];
  flat_action_bytes: number;
  spawn_actions_dir: string;
  spawn_actions_exists: boolean;
  spawn_actions_files: number;
  spawn_actions_bytes: number;
  spawn_runs_dir: string;
  spawn_runs_exists: boolean;
  spawn_runs_bytes: number;
  jobs: Array<{ job_id: string; status: string; bytes: number }>;
  jobs_active: number;
  jobs_bytes: number;
  task_count: number;
  total_bytes: number;
}

export interface DeleteSessionDeleted {
  session: boolean;
  handoff: boolean;
  transcript: boolean;
  flat_actions: number;
  spawn_actions_dir: boolean;
  spawn_runs_dir: boolean;
  jobs: number;
  jobs_cancelled: number;
  index_entries_removed: number;
}

export interface DeleteSessionResult {
  ok: boolean;
  reason?: string;
  artifacts: SessionArtifacts;
  deleted?: DeleteSessionDeleted;
}

export interface DeleteSessionOptions {
  /**
   * When set, called for each running/queued job before directory removal.
   * Defaults to JobRegistry.cancel.
   */
  cancelJob?: (jobId: string) => JobCancelOutcome;
  /** Skip deletion if any job is still active after cancel (default false — still rm). */
  refuseIfJobsActive?: boolean;
}

function safeStatSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function dirStats(dir: string): { files: number; bytes: number } {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files += 1;
        bytes += safeStatSize(p);
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Jobs whose meta.parent_session_id matches (full jobs root scan). */
export function listJobsForParentSession(parentSessionId: string): SpawnJobMeta[] {
  const root = jobsDir();
  if (!existsSync(root)) return [];
  const out: SpawnJobMeta[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('job_')) continue;
    const meta = readJobMeta(e.name);
    if (meta?.parent_session_id === parentSessionId) out.push(meta);
  }
  return out;
}

/**
 * Rewrite jobs/index.jsonl dropping entries for a parent session (and known job ids).
 * Returns number of lines removed.
 */
export function rewriteJobIndexForSessionDelete(
  parentSessionId: string,
  jobIds: string[],
): number {
  const jobSet = new Set(jobIds);
  const all = readJobIndex();
  const kept = all.filter(
    (entry) =>
      entry.parent_session_id !== parentSessionId && !jobSet.has(entry.job_id),
  );
  const removed = all.length - kept.length;
  if (removed > 0) writeJobIndex(kept);
  return removed;
}

/** Collect every known artifact for a main session (read-only). */
export function collectSessionArtifacts(sessionId: string): SessionArtifacts {
  const sid = sessionId.trim();
  const sPath = sessionPath(sid);
  const hPath = handoffPath(sid);
  const tPath = transcriptPath(sid);
  const saDir = spawnActionsDir(sid);
  const srDir = spawnRunsDir(sid);

  let taskCount = 0;
  let sessionBytes = 0;
  const exists = existsSync(sPath);
  if (exists) {
    sessionBytes = safeStatSize(sPath);
    try {
      const raw = JSON.parse(readFileSync(sPath, 'utf8')) as { tasks?: unknown[] };
      taskCount = Array.isArray(raw.tasks) ? raw.tasks.length : 0;
    } catch {
      /* ignore */
    }
  }

  const flatBlocks = listActions(sid);
  const flatIds = flatBlocks.map((b) => b.action_id);
  let flatBytes = 0;
  for (const b of flatBlocks) {
    flatBytes += safeStatSize(getActionPath(b.action_id));
  }

  const sa = dirStats(saDir);
  const sr = dirStats(srDir);

  const jobMetas = listJobsForParentSession(sid);
  const jobs = jobMetas.map((m) => {
    const st = dirStats(jobDir(m.job_id));
    return { job_id: m.job_id, status: m.status, bytes: st.bytes };
  });
  const jobsActive = jobMetas.filter(
    (m) => m.status === 'running' || m.status === 'queued',
  ).length;
  const jobsBytes = jobs.reduce((n, j) => n + j.bytes, 0);

  const handoffExists = existsSync(hPath);
  const transcriptExists = existsSync(tPath);
  const handoffBytes = handoffExists ? safeStatSize(hPath) : 0;
  const transcriptBytes = transcriptExists ? safeStatSize(tPath) : 0;

  const total =
    sessionBytes +
    handoffBytes +
    transcriptBytes +
    flatBytes +
    sa.bytes +
    sr.bytes +
    jobsBytes;

  return {
    session_id: sid,
    exists,
    session_path: sPath,
    session_bytes: sessionBytes,
    handoff_path: hPath,
    handoff_exists: handoffExists,
    handoff_bytes: handoffBytes,
    transcript_path: tPath,
    transcript_exists: transcriptExists,
    transcript_bytes: transcriptBytes,
    flat_action_ids: flatIds,
    flat_action_bytes: flatBytes,
    spawn_actions_dir: saDir,
    spawn_actions_exists: existsSync(saDir),
    spawn_actions_files: sa.files,
    spawn_actions_bytes: sa.bytes,
    spawn_runs_dir: srDir,
    spawn_runs_exists: existsSync(srDir),
    spawn_runs_bytes: sr.bytes,
    jobs,
    jobs_active: jobsActive,
    jobs_bytes: jobsBytes,
    task_count: taskCount,
    total_bytes: total,
  };
}

function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** One-line / multi-line summary for confirm dialogs. */
export function formatSessionDeleteSummary(art: SessionArtifacts): string {
  const lines = [
    `Delete ${art.session_id}?`,
    `  tasks=${art.task_count}  size≈${formatKb(art.total_bytes)}`,
    `  actions: ${art.flat_action_ids.length} main + ${art.spawn_actions_files} spawn`,
    `  jobs: ${art.jobs.length} (${art.jobs_active} active)`,
  ];
  if (art.handoff_exists) lines.push('  + handoff');
  if (art.transcript_exists) lines.push('  + transcript');
  lines.push('  (agent_memory / caches kept)');
  return lines.join('\n');
}

function rmPath(path: string, recursive = false, allowedRoot?: string): boolean {
  if (!existsSync(path)) return false;
  if (allowedRoot && !isPathInsideRoot(allowedRoot, path)) {
    return false;
  }
  try {
    rmSync(path, { recursive, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete session file + cold storage + spawn trees + parent jobs.
 * Safe to call when session json is already missing (still cleans orphans).
 */
export function deleteSession(
  sessionId: string,
  opts?: DeleteSessionOptions,
): DeleteSessionResult {
  const sid = sessionId.trim();
  if (!sid || sid.startsWith('spawn_') || !isSafeSessionId(sid)) {
    const empty = collectSessionArtifacts(isSafeSessionId(sid) ? sid : '(invalid)');
    return {
      ok: false,
      reason: 'invalid session id (expected session_[A-Za-z0-9_-]+, no path segments)',
      artifacts: empty,
    };
  }

  const artifacts = collectSessionArtifacts(sid);
  if (!artifacts.exists && artifacts.flat_action_ids.length === 0 && artifacts.jobs.length === 0) {
    // Still allow cleanup of empty-ish remnants
    if (
      !artifacts.handoff_exists &&
      !artifacts.transcript_exists &&
      !artifacts.spawn_actions_exists &&
      !artifacts.spawn_runs_exists
    ) {
      return { ok: false, reason: 'session not found', artifacts };
    }
  }

  if (opts?.refuseIfJobsActive && artifacts.jobs_active > 0) {
    return {
      ok: false,
      reason: `session has ${artifacts.jobs_active} active job(s); cancel first`,
      artifacts,
    };
  }

  const cancelJob =
    opts?.cancelJob ??
    ((jobId: string) => getJobRegistry().cancel(jobId));

  let jobsCancelled = 0;
  for (const j of artifacts.jobs) {
    if (j.status === 'running' || j.status === 'queued') {
      const outcome = cancelJob(j.job_id);
      if (outcome) jobsCancelled += 1;
    }
  }

  const deleted: DeleteSessionDeleted = {
    session: false,
    handoff: false,
    transcript: false,
    flat_actions: 0,
    spawn_actions_dir: false,
    spawn_runs_dir: false,
    jobs: 0,
    jobs_cancelled: jobsCancelled,
    index_entries_removed: 0,
  };

  // Flat main-agent actions live as siblings under actions/*.json (not spawn/).
  try {
    const dir = actionsDir();
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const p = join(dir, name);
        try {
          const block = JSON.parse(readFileSync(p, 'utf8')) as { session_id?: string };
          if (block.session_id === sid) {
            unlinkSync(p);
            deleted.flat_actions += 1;
          }
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* ignore */
  }

  const sessionsRoot = sessionsDir();
  const jobsRoot = jobsDir();

  deleted.spawn_actions_dir = rmPath(artifacts.spawn_actions_dir, true, sessionsRoot);
  deleted.spawn_runs_dir = rmPath(artifacts.spawn_runs_dir, true, sessionsRoot);

  const jobIds = artifacts.jobs
    .map((j) => j.job_id)
    .filter((id) => isSafeJobId(id));
  for (const id of jobIds) {
    const dir = jobDir(id);
    if (rmPath(dir, true, jobsRoot)) deleted.jobs += 1;
  }

  deleted.index_entries_removed = rewriteJobIndexForSessionDelete(sid, jobIds);

  deleted.handoff = rmPath(artifacts.handoff_path, false, sessionsRoot);
  deleted.transcript = rmPath(artifacts.transcript_path, false, sessionsRoot);
  deleted.session = rmPath(artifacts.session_path, false, sessionsRoot);

  return { ok: true, artifacts, deleted };
}
