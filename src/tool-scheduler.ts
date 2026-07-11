import type { ToolPlanEntry, ToolPlanReason } from './events.js';
import { decodeShellCommand } from './tools/tool-args.js';
import type { ToolCall } from './types.js';

const PARALLEL_SAFE = new Set([
  'read_file',
  'grep_search',
  'list_files',
  'diff_file',
  'recall_query',
  'invoke_skill',
  'web_fetch',
  'web_search',
  'spawn_agent',
]);

function isParallelSafeMcp(name: string): boolean {
  return name.startsWith('mcp_');
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
const SERIAL_ONLY = new Set(['write_file', 'edit_file', 'run_shell']);

export interface ToolCallPlan {
  parallel: ToolCall[];
  serial: ToolCall[];
  entries: ToolPlanEntry[];
}

interface CallDisposition {
  disposition: 'parallel' | 'serial';
  reason: ToolPlanReason;
  detail?: string;
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

function previewArgs(argsJson: string, maxLen = 120): string {
  if (argsJson.length <= maxLen) return argsJson;
  return `${argsJson.slice(0, maxLen)}…`;
}

function shellConflictDetail(path: string, shellCommands: string[]): string | undefined {
  const shell = shellCommands.find((cmd) => shellReadsPath(cmd, path));
  if (!shell) return `path=${path}`;
  const trimmed = shell.length > 60 ? `${shell.slice(0, 60)}…` : shell;
  return `path=${path} shell=${trimmed}`;
}

function classifyCalls(calls: ToolCall[]): {
  parallel: ToolCall[];
  serial: ToolCall[];
  byId: Map<string, CallDisposition>;
} {
  const serial: ToolCall[] = [];
  const parallelCandidates: ToolCall[] = [];
  const byId = new Map<string, CallDisposition>();

  const writePaths = new Set<string>();
  const shellCommands: string[] = [];

  for (const call of calls) {
    const name = call.function.name;
    const args = call.function.arguments;

    if (SERIAL_ONLY.has(name)) {
      serial.push(call);
      byId.set(call.id, {
        disposition: 'serial',
        reason: 'serial_only_tool',
        detail: name,
      });
      if (WRITE_TOOLS.has(name)) {
        const p = extractPath(args);
        if (p) writePaths.add(p);
      }
      if (name === 'run_shell') {
        try {
          const parsed = JSON.parse(args) as Record<string, unknown>;
          const decoded = decodeShellCommand(parsed);
          shellCommands.push(decoded.ok ? decoded.command : String(parsed.command ?? ''));
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
      byId.set(call.id, {
        disposition: 'serial',
        reason: 'not_parallel_safe',
      });
    }
  }

  const parallel: ToolCall[] = [];
  const pathUseCount = new Map<string, number>();

  for (const call of parallelCandidates) {
    const name = call.function.name;
    const args = call.function.arguments;
    const path = extractPath(args);
    const conflictsWrite = path ? writePaths.has(path) : false;
    const conflictsShell =
      path !== null && shellCommands.some((cmd) => shellReadsPath(cmd, path));

    if (conflictsWrite) {
      serial.push(call);
      byId.set(call.id, {
        disposition: 'serial',
        reason: 'conflicts_pending_write',
        detail: path ? `path=${path}` : undefined,
      });
      continue;
    }

    if (conflictsShell) {
      serial.push(call);
      byId.set(call.id, {
        disposition: 'serial',
        reason: 'conflicts_shell_on_path',
        detail: path ? shellConflictDetail(path, shellCommands) : undefined,
      });
      continue;
    }

    if (path) {
      const count = pathUseCount.get(path) ?? 0;
      pathUseCount.set(path, count + 1);
    }

    parallel.push(call);
    byId.set(call.id, {
      disposition: 'parallel',
      reason: 'parallel_safe',
      detail: path ? `path=${path}` : undefined,
    });
  }

  return { parallel, serial, byId };
}

/**
 * Conservative scheduler: parallelize only clearly independent read-only calls.
 */
export function scheduleToolCalls(calls: ToolCall[]): ToolCallPlan {
  const { parallel, serial, byId } = classifyCalls(calls);
  const entries: ToolPlanEntry[] = calls.map((call) => {
    const disposition = byId.get(call.id);
    if (!disposition) {
      throw new Error(`missing disposition for tool call ${call.id}`);
    }
    return {
      id: call.id,
      name: call.function.name,
      args_preview: previewArgs(call.function.arguments),
      ...disposition,
    };
  });

  return { parallel, serial, entries };
}