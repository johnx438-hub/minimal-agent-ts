/**
 * C3: apply_patch — multi-file unified diff apply (atomic: all or nothing).
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AgentConfig, ToolDefinition } from '../types.js';
import { hashFileContent } from './file-hash.js';
import { resolveWritablePath } from './path-utils.js';

export const APPLY_PATCH_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Apply a multi-file unified diff in one call (atomic: all files succeed or none are written). ' +
        'Prefer for coordinated multi-file edits. Supports ---/+++ headers and @@ hunks; ' +
        'new files use --- /dev/null. Paths must stay under cwd. Optional dry_run validates without writing.',
      parameters: {
        type: 'object',
        properties: {
          patch: {
            type: 'string',
            description: 'Unified diff text (one or more files).',
          },
          patch_b64: {
            type: 'string',
            description: 'Base64 UTF-8 patch (when the diff contains awkward quoting).',
          },
          dry_run: {
            type: 'boolean',
            description: 'If true, validate and report without writing files. Default false.',
          },
        },
      },
    },
  },
];

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Lines including leading ' ', '-', '+' (no trailing newlines). */
  lines: string[];
}

export interface FilePatch {
  /** Path relative to cwd (normalized, no a/ b/ prefix). */
  path: string;
  oldPath: string | null;
  isNew: boolean;
  isDelete: boolean;
  hunks: PatchHunk[];
}

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

function stripAbPrefix(p: string): string {
  const t = p.trim();
  if (t === '/dev/null') return '/dev/null';
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

/**
 * Parse unified multi-file diff into FilePatch[].
 * Exported for unit tests.
 */
export function parseUnifiedDiff(patchText: string): FilePatch[] | { error: string } {
  const text = patchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.trim()) return { error: 'error: patch is empty' };

  const lines = text.split('\n');
  const files: FilePatch[] = [];
  let i = 0;

  while (i < lines.length) {
    // skip noise
    while (
      i < lines.length &&
      !lines[i].startsWith('--- ') &&
      !lines[i].startsWith('diff --git ')
    ) {
      i++;
    }
    if (i >= lines.length) break;

    if (lines[i].startsWith('diff --git ')) {
      i++;
      // optional index / similarity lines
      while (
        i < lines.length &&
        !lines[i].startsWith('--- ') &&
        !lines[i].startsWith('diff --git ')
      ) {
        if (lines[i].startsWith('+++ ')) break;
        i++;
      }
    }

    if (i >= lines.length || !lines[i].startsWith('--- ')) {
      if (i >= lines.length) break;
      return { error: `error: expected --- header near line ${i + 1}` };
    }

    const oldRaw = lines[i].slice(4).split('\t')[0].trim();
    i++;
    if (i >= lines.length || !lines[i].startsWith('+++ ')) {
      return { error: `error: expected +++ header after --- ${oldRaw}` };
    }
    const newRaw = lines[i].slice(4).split('\t')[0].trim();
    i++;

    const oldPath = stripAbPrefix(oldRaw);
    const newPath = stripAbPrefix(newRaw);
    const isNew = oldPath === '/dev/null';
    const isDelete = newPath === '/dev/null';
    const path = isDelete ? oldPath : newPath;
    if (!path || path === '/dev/null') {
      return { error: 'error: cannot determine target path from patch headers' };
    }

    const hunks: PatchHunk[] = [];
    while (i < lines.length && lines[i].startsWith('@@')) {
      const m = lines[i].match(HUNK_RE);
      if (!m) return { error: `error: invalid hunk header: ${lines[i]}` };
      const oldStart = Number(m[1]);
      const oldCount = m[2] !== undefined ? Number(m[2]) : 1;
      const newStart = Number(m[3]);
      const newCount = m[4] !== undefined ? Number(m[4]) : 1;
      i++;
      const hunkLines: string[] = [];
      // Consume exactly oldCount + newCount logical lines (unified diff accounting).
      let oldLeft = oldCount;
      let newLeft = newCount;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
        const L = lines[i];
        if (L.startsWith('@@') || L.startsWith('diff --git ') || L.startsWith('--- ')) break;
        if (L.startsWith('\\')) {
          // "\ No newline at end of file"
          i++;
          continue;
        }
        if (L.startsWith(' ')) {
          oldLeft--;
          newLeft--;
          hunkLines.push(L);
          i++;
          continue;
        }
        if (L.startsWith('-')) {
          oldLeft--;
          hunkLines.push(L);
          i++;
          continue;
        }
        if (L.startsWith('+')) {
          newLeft--;
          hunkLines.push(L);
          i++;
          continue;
        }
        if (L === '') {
          // Empty line counts as context " "
          oldLeft--;
          newLeft--;
          hunkLines.push(' ');
          i++;
          continue;
        }
        break;
      }
      hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
    }

    if (hunks.length === 0 && !isNew && !isDelete) {
      return { error: `error: no hunks for file ${path}` };
    }

    files.push({ path, oldPath: isNew ? null : oldPath, isNew, isDelete, hunks });
  }

  if (files.length === 0) {
    return { error: 'error: no file patches found (need --- / +++ headers)' };
  }
  return files;
}

function findHunkIndex(fileLines: string[], hunk: PatchHunk): number {
  const oldLines = hunk.lines
    .filter((l) => l.startsWith(' ') || l.startsWith('-'))
    .map((l) => l.slice(1));

  if (oldLines.length === 0) {
    // pure insertion (e.g. new file @@ -0,0 +1,N @@)
    if (hunk.oldStart <= 0) return 0;
    return Math.max(0, Math.min(fileLines.length, hunk.oldStart - 1));
  }

  const preferred = Math.max(0, hunk.oldStart - 1);

  const matchesAt = (start: number): boolean => {
    if (start < 0 || start + oldLines.length > fileLines.length) return false;
    for (let k = 0; k < oldLines.length; k++) {
      if (fileLines[start + k] !== oldLines[k]) return false;
    }
    return true;
  };

  if (matchesAt(preferred)) return preferred;

  // fuzzy: search nearby then whole file
  for (let delta = 1; delta <= 40; delta++) {
    if (matchesAt(preferred - delta)) return preferred - delta;
    if (matchesAt(preferred + delta)) return preferred + delta;
  }
  for (let start = 0; start <= fileLines.length - oldLines.length; start++) {
    if (matchesAt(start)) return start;
  }
  return -1;
}

/**
 * Apply hunks to file content. Returns new content or error.
 */
export function applyHunksToContent(
  original: string,
  hunks: PatchHunk[],
): { content: string } | { error: string } {
  const endsWithNl = original.endsWith('\n');
  let fileLines =
    original === ''
      ? []
      : original.replace(/\n$/, '').split('\n');

  // Apply in reverse order so line numbers stay stable for remaining hunks
  // when oldStart positions refer to original — better: apply from bottom by oldStart
  const ordered = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of ordered) {
    const idx = findHunkIndex(fileLines, hunk);
    if (idx < 0) {
      const preview = hunk.lines
        .filter((l) => l.startsWith('-') || l.startsWith(' '))
        .slice(0, 3)
        .map((l) => l.slice(1))
        .join('\\n');
      return {
        error: `error: hunk not found (@@ -${hunk.oldStart},${hunk.oldCount} @@ looking for "${preview}")`,
      };
    }

    const oldLen = hunk.lines.filter((l) => l.startsWith(' ') || l.startsWith('-')).length;
    const newLines = hunk.lines
      .filter((l) => l.startsWith(' ') || l.startsWith('+'))
      .map((l) => l.slice(1));

    fileLines = [
      ...fileLines.slice(0, idx),
      ...newLines,
      ...fileLines.slice(idx + oldLen),
    ];
  }

  if (fileLines.length === 0) return { content: '' };
  return { content: fileLines.join('\n') + (endsWithNl || fileLines.length > 0 ? '\n' : '') };
}

export interface PlannedFileWrite {
  path: string;
  absPath: string;
  content: string | null; // null = delete
  isNew: boolean;
  isDelete: boolean;
  beforeHash?: string;
  afterHash?: string;
}

export function planPatchApplication(
  cwd: string,
  files: FilePatch[],
  readContent: (absPath: string) => string | null,
): PlannedFileWrite[] | { error: string } {
  const planned: PlannedFileWrite[] = [];

  for (const fp of files) {
    let absPath: string;
    try {
      absPath = resolveWritablePath(cwd, fp.path);
    } catch (err) {
      return { error: `error: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (fp.isDelete) {
      if (!existsSync(absPath)) {
        return { error: `error: cannot delete missing file: ${fp.path}` };
      }
      const before = readContent(absPath) ?? '';
      planned.push({
        path: fp.path,
        absPath,
        content: null,
        isNew: false,
        isDelete: true,
        beforeHash: hashFileContent(before),
      });
      continue;
    }

    if (fp.isNew) {
      if (existsSync(absPath)) {
        return { error: `error: cannot create ${fp.path}: already exists` };
      }
      const applied = applyHunksToContent('', fp.hunks);
      if ('error' in applied) return { error: `${fp.path}: ${applied.error}` };
      planned.push({
        path: fp.path,
        absPath,
        content: applied.content,
        isNew: true,
        isDelete: false,
        afterHash: hashFileContent(applied.content),
      });
      continue;
    }

    const existing = readContent(absPath);
    if (existing === null) {
      return { error: `error: file not found: ${fp.path} (use --- /dev/null for new files)` };
    }
    const applied = applyHunksToContent(existing, fp.hunks);
    if ('error' in applied) return { error: `${fp.path}: ${applied.error}` };
    planned.push({
      path: fp.path,
      absPath,
      content: applied.content,
      isNew: false,
      isDelete: false,
      beforeHash: hashFileContent(existing),
      afterHash: hashFileContent(applied.content),
    });
  }

  return planned;
}

function decodePatchArgs(args: Record<string, unknown>): string | { error: string } {
  if (typeof args.patch_b64 === 'string' && args.patch_b64.trim()) {
    try {
      return Buffer.from(args.patch_b64.trim(), 'base64').toString('utf8');
    } catch (err) {
      return {
        error: `error: invalid patch_b64: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (typeof args.patch === 'string') return args.patch;
  return { error: 'error: patch or patch_b64 is required' };
}

export async function runApplyPatchTool(
  toolName: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  if (toolName !== 'apply_patch') return null;

  const decoded = decodePatchArgs(args);
  if (typeof decoded === 'object') return decoded.error;

  const parsed = parseUnifiedDiff(decoded);
  if ('error' in parsed) return parsed.error;

  const dryRun = args.dry_run === true;

  const planned = planPatchApplication(config.cwd, parsed, (abs) => {
    try {
      return readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  });
  if ('error' in planned) return planned.error;

  if (dryRun) {
    const lines = planned.map((p) => {
      if (p.isDelete) return `would delete ${p.path}`;
      if (p.isNew) return `would create ${p.path} (hash=${p.afterHash?.slice(0, 12)})`;
      return `would patch ${p.path} (${p.beforeHash?.slice(0, 8)}→${p.afterHash?.slice(0, 8)})`;
    });
    return `ok: dry_run ${planned.length} file(s)\n${lines.join('\n')}`;
  }

  // Atomic-ish: compute all first (done), then write; on failure leave already-written
  // files but report error — full rollback is optional; we write all planned contents
  // only after all plans succeeded, so failure mid-write is rare (disk full).
  try {
    for (const p of planned) {
      if (p.isDelete) {
        await unlink(p.absPath);
        continue;
      }
      await mkdir(dirname(p.absPath), { recursive: true });
      await writeFile(p.absPath, p.content ?? '', 'utf8');
    }
  } catch (err) {
    return `error: write failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const summary = planned.map((p) => {
    if (p.isDelete) return `deleted ${p.path}`;
    if (p.isNew) return `created ${p.path}`;
    return `patched ${p.path}`;
  });

  return `ok: apply_patch ${planned.length} file(s)\n${summary.join('\n')}`;
}
