import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { resolveSafePath } from '../tools/path-utils.js';

function parentDirForOutputPath(cwd: string, outputPath: string): string | null {
  const trimmed = outputPath.trim();
  if (!trimmed) return null;

  try {
    const target = isAbsolute(trimmed) ? resolve(trimmed) : resolveSafePath(cwd, trimmed);
    return dirname(target);
  } catch {
    return null;
  }
}

/** Create parent directories for hinted spawn job report paths before the sub-agent runs. */
export function ensureSpawnOutputPaths(cwd: string, outputPaths: string[] | undefined): void {
  if (!outputPaths?.length) return;

  for (const outputPath of outputPaths) {
    const parent = parentDirForOutputPath(cwd, outputPath);
    if (!parent || existsSync(parent)) continue;
    mkdirSync(parent, { recursive: true });
  }
}