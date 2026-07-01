import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { releaseAllCompactedContent } from './context-policy.js';
import type { SessionFile, SessionMeta } from './types.js';
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
  const session: SessionFile = {
    session_id: sessionId,
    user_id: userId,
    created_at: Date.now(),
    tasks: [],
    current_messages: [],
  };

  ensureSessionsDir();
  const path = sessionPath(sessionId);
  writeFileSync(path, JSON.stringify(session, null, 2), 'utf8');

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
  ensureSessionsDir();
  const path = sessionPath(session.session_id);
  writeFileSync(path, JSON.stringify(session, null, 2), 'utf8');
  lastSaveAtBySession.set(session.session_id, Date.now());
}

/**
 * List all available sessions for a user.
 * Returns sessions sorted by created_at (newest first).
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
      const content = readFileSync(path, 'utf8');
      const session = JSON.parse(content) as SessionFile;

      if (userId && session.user_id !== userId) {
        continue;
      }

      sessions.push({
        session_id: session.session_id,
        user_id: session.user_id,
        created_at: session.created_at,
        task_count: session.tasks.length,
        path,
      });
    } catch {
      continue;
    }
  }

  sessions.sort((a, b) => b.created_at - a.created_at);
  return sessions;
}

/**
 * Get the most recent session for a user.
 */
export function getLatestSession(userId?: string): SessionMeta | null {
  const sessions = listSessions(userId);
  return sessions[0] ?? null;
}