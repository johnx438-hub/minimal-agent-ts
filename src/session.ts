import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';

import { releaseAllCompactedContent } from './context/prune.js';
import type { SessionFile, SessionMeta, SessionOverview } from './types.js';
import {
  buildSessionWorkspaceState,
  ensureSessionsDir,
  sessionPath,
  sessionsDir,
} from './workspace.js';

const DEFAULT_SAVE_MIN_INTERVAL_MS = 30_000;
const lastSaveAtBySession = new Map<string, number>();

export function getSessionSaveMinIntervalMs(): number {
  const raw = process.env.SESSION_SAVE_MIN_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_SAVE_MIN_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SAVE_MIN_INTERVAL_MS;
}

export interface SaveSessionOptions {
  /** Bypass throttle (run end, abort, workflow checkpoint). */
  force?: boolean;
  minIntervalMs?: number;
}

/**
 * Persist session; skips write when called too soon unless force=true.
 * Returns true if a write occurred.
 */
export function saveSessionThrottled(
  session: SessionFile,
  opts?: SaveSessionOptions,
): boolean {
  const force = opts?.force ?? false;
  const minInterval = opts?.minIntervalMs ?? getSessionSaveMinIntervalMs();
  const now = Date.now();
  const last = lastSaveAtBySession.get(session.session_id) ?? 0;

  if (!force && minInterval > 0 && now - last < minInterval) {
    return false;
  }

  saveSession(session);
  lastSaveAtBySession.set(session.session_id, now);
  return true;
}

/**
 * Generate a session ID based on current timestamp.
 * Format: session_YYYYMMDD_HHMMSS
 */
export function generateSessionId(): string {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  return `session_${dateStr}`;
}

/** @deprecated Use sessionPath from workspace; kept for callers that import by name. */
export function getSessionPath(sessionId: string): string {
  return sessionPath(sessionId);
}

/**
 * Create a new session and persist it to disk.
 */
export function createSession(userId: string = 'user_default'): SessionFile {
  const sessionId = generateSessionId();
  const now = Date.now();
  const session: SessionFile = {
    session_id: sessionId,
    user_id: userId,
    created_at: now,
    updated_at: now,
    tasks: [],
    current_messages: [],
    workspace: buildSessionWorkspaceState(),
  };

  ensureSessionsDir();
  saveSession(session);

  return session;
}

/**
 * Load an existing session from disk.
 * Returns null if session not found.
 */
export function loadSession(sessionId: string): SessionFile | null {
  const path = sessionPath(sessionId);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf8');
    const session = JSON.parse(content) as SessionFile;
    releaseAllCompactedContent(session.current_messages);
    return session;
  } catch {
    return null;
  }
}

/**
 * Save session state to disk.
 */
export function saveSession(session: SessionFile): void {
  releaseAllCompactedContent(session.current_messages);
  session.updated_at = Date.now();
  // Keep workspace snapshot in sync with process grants/cwd when present.
  if (session.workspace) {
    const snap = buildSessionWorkspaceState(
      session.workspace.inherit_capabilities_on_cwd_switch,
    );
    session.workspace = {
      ...snap,
      // Preserve project identity for agent_home buckets
      project_id: session.workspace.project_id || snap.project_id,
      primary_root: session.workspace.primary_root || snap.primary_root,
    };
  }
  ensureSessionsDir();
  const path = sessionPath(session.session_id);
  writeFileSync(path, JSON.stringify(session, null, 2), 'utf8');
  lastSaveAtBySession.set(session.session_id, session.updated_at);
}

const SESSION_PREVIEW_MAX_CHARS = 72;
const SESSION_NOTE_MAX_CHARS = 80;
const TASK_SUMMARY_PREVIEW_MAX_CHARS = 56;
const TASK_INTENT_PREVIEW_MAX_CHARS = 48;
const LABEL_NOTE_MAX_CHARS = 28;

/** One-line preview of the most recent user message in a session. */
export function lastUserMessagePreview(
  session: Pick<SessionFile, 'current_messages' | 'tasks'>,
): string {
  for (let i = session.current_messages.length - 1; i >= 0; i--) {
    const msg = session.current_messages[i];
    if (msg?.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text) return clipSessionPreview(text);
    }
  }

  const lastTask = session.tasks[session.tasks.length - 1];
  if (lastTask) {
    const lastMsg = lastTask.user_messages[lastTask.user_messages.length - 1];
    if (lastMsg?.trim()) return clipSessionPreview(lastMsg.trim());
    if (lastTask.user_intent?.trim()) return clipSessionPreview(lastTask.user_intent.trim());
  }

  return '(no user message)';
}

export function clipSessionPreview(text: string, max = SESSION_PREVIEW_MAX_CHARS): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

/** Latest completed task user_intent, clipped for list descriptions. */
export function lastTaskIntentPreview(
  session: Pick<SessionFile, 'tasks'>,
): string | undefined {
  const intent = session.tasks[session.tasks.length - 1]?.user_intent?.trim();
  if (!intent) return undefined;
  return clipSessionPreview(intent, TASK_INTENT_PREVIEW_MAX_CHARS);
}

/**
 * Best one-line summary of what the session was about (list right column).
 * Priority: in-flight user → last task current_work → user_intent → user_messages.
 */
export function lastTaskSummaryPreview(
  session: Pick<SessionFile, 'current_messages' | 'tasks'>,
): string {
  if (session.current_messages.length > 0) {
    for (let i = session.current_messages.length - 1; i >= 0; i--) {
      const msg = session.current_messages[i];
      if (msg?.role === 'user') {
        const text = typeof msg.content === 'string' ? msg.content.trim() : '';
        if (text) return clipSessionPreview(text, TASK_SUMMARY_PREVIEW_MAX_CHARS);
      }
    }
  }

  const lastTask = session.tasks[session.tasks.length - 1];
  if (!lastTask) return '(empty)';

  const work = lastTask.current_work?.trim();
  if (work) return clipSessionPreview(work, TASK_SUMMARY_PREVIEW_MAX_CHARS);

  const intent = lastTask.user_intent?.trim();
  if (intent) return clipSessionPreview(intent, TASK_SUMMARY_PREVIEW_MAX_CHARS);

  const lastMsg = lastTask.user_messages[lastTask.user_messages.length - 1]?.trim();
  if (lastMsg) return clipSessionPreview(lastMsg, TASK_SUMMARY_PREVIEW_MAX_CHARS);

  return '(empty)';
}

/** Up to 2 file basenames from the latest completed task. */
export function lastTaskFilesPreview(
  session: Pick<SessionFile, 'tasks'>,
  max = 2,
): string[] {
  const files = session.tasks[session.tasks.length - 1]?.files_touched ?? [];
  const out: string[] = [];
  for (const f of files) {
    const base = f.replace(/\\/g, '/').split('/').pop() || f;
    if (!base || out.includes(base)) continue;
    out.push(base);
    if (out.length >= max) break;
  }
  return out;
}

/** Local `MM-DD HH:mm` for picker left column. */
export function formatSessionActiveShort(meta: Pick<SessionMeta, 'created_at' | 'updated_at'>): string {
  const d = new Date(meta.updated_at ?? meta.created_at);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** Compact id tail for list when no note (e.g. session_…HHMMSS → HHMMSS). */
export function shortSessionId(sessionId: string): string {
  const m = sessionId.match(/session_\d{8}(\d{6})$/);
  if (m) return m[1]!;
  if (sessionId.length <= 10) return sessionId;
  return sessionId.slice(-6);
}

/**
 * Left column: time + note (or short id) + current marker.
 * Note is the human anchor when present.
 */
export function formatSessionPickerLabel(
  meta: SessionMeta,
  opts?: { currentId?: string },
): string {
  const ts = formatSessionActiveShort(meta);
  const cur = opts?.currentId && opts.currentId === meta.session_id ? ' ●' : '';
  const note = meta.note?.trim();
  if (note) {
    return `${ts} · ${clipSessionPreview(note, LABEL_NOTE_MAX_CHARS)}${cur}`;
  }
  return `${ts} · ${shortSessionId(meta.session_id)}${cur}`;
}

/**
 * Right column: task summary · optional files · Nt · optional ★.
 * In-flight sessions prefix summary with […].
 */
export function formatSessionPickerDescription(meta: SessionMeta): string {
  const summaryRaw =
    meta.last_task_summary?.trim() ||
    meta.last_user_preview?.trim() ||
    '(empty)';
  const summary = meta.has_in_flight ? `[…] ${summaryRaw}` : summaryRaw;
  const files = meta.last_files_touched?.length
    ? `files: ${meta.last_files_touched.join(', ')}`
    : '';
  const tasks = `${meta.task_count}t`;
  const star = meta.note?.trim() ? '★' : '';
  return [summary, files, tasks, star].filter(Boolean).join(' · ');
}

export function normalizeSessionNote(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const one = raw.replace(/\s+/g, ' ').trim();
  if (!one) return undefined;
  return one.length <= SESSION_NOTE_MAX_CHARS
    ? one
    : `${one.slice(0, SESSION_NOTE_MAX_CHARS - 1)}…`;
}

/**
 * Persist a human note on a session file. Empty/whitespace clears the note.
 * Returns false if session missing.
 */
export function setSessionNote(sessionId: string, note: string | undefined | null): boolean {
  const session = loadSession(sessionId);
  if (!session) return false;
  const normalized = normalizeSessionNote(note);
  if (normalized) session.note = normalized;
  else delete session.note;
  saveSession(session);
  return true;
}

export function getSessionNoteMaxChars(): number {
  return SESSION_NOTE_MAX_CHARS;
}

/** Build read-only overview for session detail overlay (newest tasks first). */
export function buildSessionOverview(session: SessionFile): SessionOverview {
  const inFlight = lastUserMessagePreview(session);
  const hasInFlight = session.current_messages.length > 0;
  const tasks = [...session.tasks].reverse().slice(0, 10).map((t) => ({
    task_id: t.task_id,
    user_intent: t.user_intent,
    turn_range: t.turn_range,
    files_touched: t.files_touched,
  }));

  return {
    session_id: session.session_id,
    created_at: session.created_at,
    updated_at: session.updated_at,
    task_count: session.tasks.length,
    in_flight_preview: hasInFlight ? inFlight : '(no in-flight task)',
    has_in_flight: hasInFlight,
    note: session.note?.trim() || undefined,
    tasks,
  };
}

/** Sort key for resume-last: prefer updated_at, then file mtime, then created_at. */
export function sessionActiveAt(
  session: Pick<SessionFile, 'created_at' | 'updated_at'>,
  fileMtimeMs?: number,
): number {
  return session.updated_at ?? fileMtimeMs ?? session.created_at;
}

/**
 * List all available sessions for a user.
 * Returns sessions sorted by last activity (updated_at), newest first.
 */
export function listSessions(userId?: string): SessionMeta[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) {
    return [];
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  const sessions: SessionMeta[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const path = resolve(dir, entry.name);
    try {
      const stat = statSync(path);
      const content = readFileSync(path, 'utf8');
      const session = JSON.parse(content) as SessionFile;

      if (userId && session.user_id !== userId) {
        continue;
      }

      const updated_at = session.updated_at ?? stat.mtimeMs;

      const note = session.note?.trim() || undefined;
      sessions.push({
        session_id: session.session_id,
        user_id: session.user_id,
        created_at: session.created_at,
        updated_at,
        task_count: session.tasks.length,
        path,
        last_user_preview: lastUserMessagePreview(session),
        last_task_intent: lastTaskIntentPreview(session),
        last_task_summary: lastTaskSummaryPreview(session),
        last_files_touched: lastTaskFilesPreview(session),
        note,
        has_in_flight: session.current_messages.length > 0,
      });
    } catch {
      continue;
    }
  }

  sessions.sort(
    (a, b) =>
      (b.updated_at ?? b.created_at) - (a.updated_at ?? a.created_at),
  );
  return sessions;
}

/**
 * Get the most recently active session for a user.
 */
export function getLatestSession(userId?: string): SessionMeta | null {
  const sessions = listSessions(userId);
  return sessions[0] ?? null;
}