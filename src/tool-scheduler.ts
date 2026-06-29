import type { ToolCall } from './types.js';

const PARALLEL_SAFE = new Set([
  'read_file',
  'grep_search',
  'list_files',
  'diff_file',
  'recall_query',
  'invoke_skill',
]);

function isParallelSafeMcp(name: string): boolean {
  return name.startsWith('mcp_');
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
const SERIAL_ONLY = new Set(['write_file', 'edit_file', 'run_shell']);

export interface ToolCallPlan {
  parallel: ToolCall[];
  serial: ToolCall[];
}

function extractPath(argsJson: string): string | null {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    return typeof args.path === 'string' ? args.path : null;
  } catch {
    return null;
  }
}

function shellReadsPath(command: string, path: string): boolean {
  return command.includes(path) || command.includes(`>${path}`) || command.includes(`>>${path}`);
}

/**
 * Conservative scheduler: parallelize only clearly independent read-only calls.
 */
export function scheduleToolCalls(calls: ToolCall[]): ToolCallPlan {
  const serial: ToolCall[] = [];
  const parallelCandidates: ToolCall[] = [];

  const writePaths = new Set<string>();
  const shellCommands: string[] = [];

  for (const call of calls) {
    const name = call.function.name;
    if (SERIAL_ONLY.has(name)) {
      serial.push(call);
      if (WRITE_TOOLS.has(name)) {
        const p = extractPath(call.function.arguments);
        if (p) writePaths.add(p);
      }
      if (name === 'run_shell') {
        try {
          const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
          shellCommands.push(String(args.command ?? ''));
        } catch {
          shellCommands.push('');
        }
      }
      continue;
    }

    if (PARALLEL_SAFE.has(name) || isParallelSafeMcp(name)) {
      parallelCandidates.push(call);
    } else {
      serial.push(call);
    }
  }

  const parallel: ToolCall[] = [];
  const pathUseCount = new Map<string, number>();

  for (const call of parallelCandidates) {
    const path = extractPath(call.function.arguments);
    const conflictsWrite = path ? writePaths.has(path) : false;
    const conflictsShell =
      path && shellCommands.some((cmd) => shellReadsPath(cmd, path));

    if (conflictsWrite || conflictsShell) {
      serial.push(call);
      continue;
    }

    if (path) {
      const count = pathUseCount.get(path) ?? 0;
      // Multiple reads of same path in one batch: still parallel-safe
      pathUseCount.set(path, count + 1);
    }

    parallel.push(call);
  }

  return { parallel, serial };
}