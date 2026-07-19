/**
 * GUI attachment inbox under workspace/ (cwd-relative, agent-readable).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const MAX_BYTES = 25 * 1024 * 1024;
const INBOX_REL = join('workspace', 'gui-inbox');

export function sanitizeUploadName(name: string): string {
  const base = basename(name || 'file').replace(/[^\w.\-()+@]+/g, '_');
  const clipped = base.slice(0, 120) || 'file';
  // Avoid empty extension-only names
  return clipped === '.' || clipped === '..' ? 'file' : clipped;
}

export function resolveInboxDir(cwd: string, sessionId?: string | null): string {
  const sess = (sessionId?.trim() || 'nosession').replace(/[^\w.-]+/g, '_').slice(0, 64);
  return resolve(cwd, INBOX_REL, sess);
}

/**
 * Write one file into workspace/gui-inbox/<session>/.
 * Returns a cwd-relative path for the agent (posix-style separators).
 */
export function saveGuiUpload(opts: {
  cwd: string;
  sessionId?: string | null;
  filename: string;
  bytes: Buffer;
}): { relativePath: string; absolutePath: string; bytes: number } {
  if (opts.bytes.length > MAX_BYTES) {
    throw new Error(`file_too_large: max ${MAX_BYTES} bytes`);
  }
  if (opts.bytes.length === 0) {
    throw new Error('empty_file');
  }

  const dir = resolveInboxDir(opts.cwd, opts.sessionId);
  mkdirSync(dir, { recursive: true });

  const safe = sanitizeUploadName(opts.filename);
  const stamp = Date.now().toString(36);
  const diskName = `${stamp}-${safe}`;
  const absolutePath = join(dir, diskName);
  writeFileSync(absolutePath, opts.bytes);

  const relativePath = [INBOX_REL, basename(dir), diskName]
    .join('/')
    .replace(/\\/g, '/');

  return {
    relativePath,
    absolutePath,
    bytes: opts.bytes.length,
  };
}

export const GUI_UPLOAD_MAX_BYTES = MAX_BYTES;
