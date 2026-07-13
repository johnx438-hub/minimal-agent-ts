import { editStatusFromOutput } from './edit-display.js';
import { shellStatusFromOutput } from './shell-display.js';
import { writeStatusFromOutput } from '../../tools/write-display.js';

export type ToolDisplayTier = 'rich' | 'shell_fold' | 'breadcrumb';

const RICH_TOOLS = new Set(['write_file', 'edit_file']);
const SHELL_TOOLS = new Set(['run_shell']);

export function toolDisplayTier(name: string): ToolDisplayTier {
  if (RICH_TOOLS.has(name)) return 'rich';
  if (SHELL_TOOLS.has(name)) return 'shell_fold';
  return 'breadcrumb';
}

export function isToolFailure(name: string, output: string): boolean {
  const trimmed = output.trim();
  if (trimmed.startsWith('[aborted]')) return true;

  if (name === 'write_file') return writeStatusFromOutput(output) === 'error';
  if (name === 'edit_file') return editStatusFromOutput(output) === 'error';
  if (name === 'run_shell') return shellStatusFromOutput(output) !== 'ok';

  return trimmed.startsWith('error:');
}

function parseArgsJson(argsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function clipText(text: string, max = 72): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One-line behavior summary for read/list/grep and other low-noise tools. */
export function formatToolBreadcrumb(name: string, argsJson: string, output: string): string {
  const args = parseArgsJson(argsJson);

  switch (name) {
    case 'read_file': {
      const path = clipText(String(args.path ?? '?'));
      const metaMatch = output.match(/\[file_meta hash=[a-f0-9]+ lines=(\d+)\]/);
      const totalLines = metaMatch?.[1];
      const offset = args.offset !== undefined ? Number(args.offset) : undefined;
      const limit = args.limit !== undefined ? Number(args.limit) : undefined;
      let slice = '';
      if (offset !== undefined && Number.isFinite(offset)) {
        slice =
          limit !== undefined && Number.isFinite(limit)
            ? ` @L${offset}-${offset + limit - 1}`
            : ` @L${offset}`;
      }
      const lineNote = totalLines ? `${totalLines} lines` : 'ok';
      return `← read: ${path} (${lineNote}${slice})`;
    }
    case 'list_files': {
      const path = clipText(String(args.path ?? '.'));
      const count = Math.max(0, output.split('\n').filter((l) => l.trim()).length - 1);
      return `← list: ${path} (${count} entries)`;
    }
    case 'grep_search': {
      const pattern = clipText(String(args.pattern ?? ''), 40);
      const path = clipText(String(args.path ?? '.'));
      if (output.trim() === '(no matches)') {
        return `← grep: "${pattern}" in ${path} (0 matches)`;
      }
      const matches = output.split('\n').filter((l) => l.trim()).length;
      return `← grep: "${pattern}" in ${path} (${matches} matches)`;
    }
    case 'diff_file': {
      const path = clipText(String(args.path ?? '?'));
      if (output.trim() === '(no differences)') return `← diff: ${path} (unchanged)`;
      const lines = output.split('\n').filter((l) => l.trim()).length;
      return `← diff: ${path} (${lines} diff lines)`;
    }
    case 'recall_query': {
      if (args.action_id !== undefined) {
        return `← recall: ${clipText(String(args.action_id), 24)}`;
      }
      const query = clipText(String(args.query ?? 'search'), 40);
      return `← recall: "${query}"`;
    }
    case 'invoke_skill': {
      const skill = clipText(String(args.name ?? 'list'));
      return `← skill: ${skill}`;
    }
    case 'apply_patch': {
      const dry = args.dry_run === true ? ' (dry_run)' : '';
      return `← apply_patch${dry}`;
    }
    case 'test_run': {
      const cmd = clipText(String(args.command ?? 'npm test'), 48);
      return `← test_run: ${cmd}`;
    }
    case 'git_status':
      return '← git status';
    case 'git_diff': {
      const staged = args.staged === true ? ' --cached' : '';
      const path = args.path !== undefined ? ` ${clipText(String(args.path), 40)}` : '';
      return `← git diff${staged}${path}`;
    }
    case 'git_log': {
      const n = args.max_count !== undefined ? String(args.max_count) : '15';
      return `← git log -${n}`;
    }
    case 'lsp_query': {
      const op = clipText(String(args.operation ?? '?'), 16);
      const path = clipText(String(args.path ?? '?'), 40);
      const line = args.line !== undefined ? String(args.line) : '?';
      return `← lsp ${op}: ${path}:${line}`;
    }
    case 'web_search': {
      const q = clipText(String(args.query ?? '?'), 48);
      return `← search: ${q}`;
    }
    case 'web_fetch': {
      const url = clipText(String(args.url ?? '?'), 60);
      if (output.includes('[web_spill]') || output.includes('.cache/web-fetch')) {
        return `← fetch: ${url} (spilled)`;
      }
      return `← fetch: ${url}`;
    }
    case 'spawn_agent': {
      const preset = clipText(String(args.preset ?? '?'));
      return `← spawn: ${preset}`;
    }
    case 'spawn_background': {
      const preset = clipText(String(args.preset ?? '?'));
      return `← spawn_bg: ${preset}`;
    }
    case 'code_review': {
      const mode = args.background === true ? 'background' : 'sync';
      return `← code_review: ${mode}`;
    }
    default:
      return `← ${name}: ok`;
  }
}

export function formatGenericToolFailureLine(
  name: string,
  output: string,
  preview?: string,
): string {
  const source = (preview ?? output).trim();
  const shown = source.length > 400 ? `${source.slice(0, 400)}…` : source;
  return `✗ ${name}: ${shown.replace(/\n/g, '\\n')}`;
}