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
import { ensureSessionsDir, sessionPath, sessionsDir } from './workspace.js';

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
  ensureSessionsDir();
  const path = sessionPath(session.session_id);
  writeFileSync(path, JSON.stringify(session, null, 2), 'utf8');
  lastSaveAtBySession.set(session.session_id, session.updated_at);
}

const SESSION_PREVIEW_MAX_CHARS = 72;

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

function clipSessionPreview(text: string, max = SESSION_PREVIEW_MAX_CHARS): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

const TASK_INTENT_PREVIEW_MAX_CHARS = 48;

/** Latest completed task user_intent, clipped for list descriptions. */
export function lastTaskIntentPreview(
  session: Pick<SessionFile, 'tasks'>,
): string | undefined {
  const intent = session.tasks[session.tasks.length - 1]?.user_intent?.trim();
  if (!intent) return undefined;
  return clipSessionPreview(intent, TASK_INTENT_PREVIEW_MAX_CHARS);
}

export function formatSessionPickerDescription(meta: SessionMeta): string {
  const active = new Date(meta.updated_at ?? meta.created_at).toISOString().slice(0, 16);
  const preview = meta.last_user_preview ?? '(no user message)';
  const intent = meta.last_task_intent
    ? `intent: ${meta.last_task_intent}`
    : 'intent: (none)';
  return `${preview} · tasks=${meta.task_count} · active=${active} · ${intent}`;
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

      sessions.push({
        session_id: session.session_id,
        user_id: session.user_id,
        created_at: session.created_at,
        updated_at,
        task_count: session.tasks.length,
        path,
        last_user_preview: lastUserMessagePreview(session),
        last_task_intent: lastTaskIntentPreview(session),
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