import { isAbsolute, resolve } from 'node:path';

export function resolveSafePath(cwd: string, input: string): string {
  const target = isAbsolute(input) ? input : resolve(cwd, input);
  const root = resolve(cwd);
  if (!target.startsWith(root)) {
    throw new Error(`path escapes working directory: ${input}`);
  }
  return target;
}

export function sliceLines(text: string, offset?: number, limit?: number): string {
  const lines = text.split('\n');
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join('\n');
}