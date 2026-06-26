import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { SessionFile, SessionMeta } from './types.js';

const SESSION_DIR = resolve(process.cwd(), '.sessions');
const SESSION_FILE_PREFIX = 'session_';

/**
 * Generate a session ID based on current timestamp.
 * Format: session_YYYYMMDD_HHMMSS
 */
export function generateSessionId(): string {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14); // YYYYMMDDHHmmss
  return `session_${dateStr}`;
}

/**
 * Get the file path for a session.
 */
export function getSessionPath(sessionId: string): string {
  return resolve(SESSION_DIR, `${sessionId}.json`);
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

  // Ensure session directory exists
  if (!existsSync(SESSION_DIR)) {
    mkdirSync(SESSION_DIR, { recursive: true });
  }

  // Write to disk
  const path = getSessionPath(sessionId);
  writeFileSync(path, JSON.stringify(session, null, 2), 'utf8');

  return session;
}

/**
 * Load an existing session from disk.
 * Returns null if session not found.
 */
export function loadSession(sessionId: string): SessionFile | null {
  const path = getSessionPath(sessionId);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf8');
    return JSON.parse(content) as SessionFile;
  } catch {
    return null;
  }
}

/**
 * Save session state to disk.
 */
export function saveSession(session: SessionFile): void {
  const path = getSessionPath(session.session_id);
  writeFileSync(path, JSON.stringify(session, null, 2), 'utf8');
}

/**
 * List all available sessions for a user.
 * Returns sessions sorted by created_at (newest first).
 */
export function listSessions(userId?: string): SessionMeta[] {
  if (!existsSync(SESSION_DIR)) {
    return [];
  }

  const entries = readdirSync(SESSION_DIR, { withFileTypes: true });
  const sessions: SessionMeta[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const path = resolve(SESSION_DIR, entry.name);
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
      // Skip invalid files
      continue;
    }
  }

  // Sort by created_at descending (newest first)
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
