import type { MemorySlashAction } from '../workspace-memory.js';
import { parseMemorySlash } from '../workspace-memory.js';

export type ApproveKind = 'shell' | 'web';

export type ApproveAction =
  | { type: 'status' }
  | { type: 'session'; kind: ApproveKind }
  | { type: 'always'; kind: ApproveKind }
  | { type: 'revoke'; kind: ApproveKind };

export type LlmSlashAction =
  | { kind: 'profile'; mode: 'list' | 'set' | 'reset'; name?: string }
  | { kind: 'model'; mode: 'list' | 'set' | 'reset'; model?: string }
  | { kind: 'reasoning'; mode: 'list' | 'set' | 'reset'; level?: string };

export type JobsSlashAction =
  | { kind: 'list' }
  | { kind: 'status'; jobId: string }
  | { kind: 'tail'; jobId: string };

export type SpawnsSlashAction = { kind: 'list' };

export interface SlashResult {
  handled: boolean;
  message?: string;
  quit?: boolean;
  runTask?: string;
  runWorkflow?: { path: string; task: string };
  armWorkflow?: string | null;
  stop?: boolean;
  newSessionBrief?: boolean;
  clearContext?: boolean;
  briefWrite?: boolean;
  /** Session id to load; omit = current session. */
  briefLoad?: string;
  approveAction?: ApproveAction;
  memoryAction?: MemorySlashAction;
  /** Usage or error text when memoryAction could not be parsed. */
  memoryMessage?: string;
  llmAction?: LlmSlashAction;
  jobsAction?: JobsSlashAction;
  spawnsAction?: SpawnsSlashAction;
}

/** Single source of truth for slash help, aliases, and autocomplete hints. */
export interface SlashHelpEntry {
  /** Primary form shown in /help (may include arg pattern). */
  command: string;
  hintZh: string;
  hintEn: string;
  /** Extra aliases resolving to the primary command word (e.g. /session → /sessions). */
  aliases?: string[];
  /** Tab-complete name without leading slash; defaults to first token of command. */
  autocompleteName?: string;
  /** Set false for help-only sub-lines (no duplicate autocomplete entry). */
  autocomplete?: boolean;
}

const SLASH_HELP_ENTRIES: SlashHelpEntry[] = [
  {
    command: '/sessions',
    hintZh: '会话列表（摘要 · n 备注 · d 删除 · i 详情）',
    hintEn: 'Session list (summary · n note · d delete · i detail)',
  },
  {
    command: '/resume [id|last]',
    aliases: ['/r'],
    hintZh: '恢复会话；省略 id 或 last = 最近活跃',
    hintEn: 'Resume session; omit id or last = most recently active',
  },
  {
    command: '/new',
    hintZh: '新建空会话',
    hintEn: 'Start a new session',
  },
  {
    command: '/new brief',
    autocomplete: false,
    hintZh: '写会话摘要并新建会话',
    hintEn: 'Write session brief, new session, queue load',
  },
  {
    command: '/brief',
    hintZh: '写会话交接摘要（非 git/worktree 迁移）',
    hintEn: 'Write session brief markdown (not git/worktree transfer)',
  },
  {
    command: '/brief load [id]',
    autocomplete: false,
    hintZh: '排队加载摘要（下条任务注入）',
    hintEn: 'Queue brief for next task injection',
  },
  {
    command: '/memory',
    hintZh: '跨 session 记忆（.agent/memory/）',
    hintEn: 'Cross-session memory files',
  },
  {
    command: '/memory show [profile|archives|requirements]',
    autocomplete: false,
    hintZh: '查看记忆文件',
    hintEn: 'Show memory file contents',
  },
  {
    command: '/memory init',
    autocomplete: false,
    hintZh: '创建 profile/archives/requirements 模板',
    hintEn: 'Create memory file templates',
  },
  {
    command: '/actions [session_id]',
    hintZh: '审计当前会话任务与工具调用',
    hintEn: 'Audit task and tool actions in session',
  },
  {
    command: '/transcript [session_id]',
    hintZh: '浏览会话对话时间线（user/assistant）',
    hintEn: 'Browse session conversation timeline',
  },
  {
    command: '/clear',
    hintZh: '清空进行中上下文（保留任务摘要）',
    hintEn: 'Clear in-flight context (keep task summaries)',
  },
  {
    command: '/quit',
    hintZh: '退出 TUI',
    hintEn: 'Exit TUI',
  },
  {
    command: '/profile [name|reset]',
    hintZh: '切换 api profile（仅主 Agent 本会话）',
    hintEn: 'Switch api profile (main agent, this session)',
  },
  {
    command: '/model [id|reset]',
    hintZh: '覆盖 model（仅主 Agent 本会话）',
    hintEn: 'Override model (main agent, this session)',
  },
  {
    command: '/reasoning [level|reset]',
    hintZh: '推理强度（reasoning_map，仅主 Agent 本会话）',
    hintEn: 'Reasoning effort via reasoning_map (main agent, this session)',
  },
  {
    command: '/shell on|off',
    hintZh: '开关 shell（仅本会话）',
    hintEn: 'Toggle run_shell (this session only)',
  },
  {
    command: '/web on|off',
    hintZh: '开关 web（仅本会话）',
    hintEn: 'Toggle web_fetch (this session only)',
  },
  {
    command: '/approve status',
    hintZh: '查看授权与 prefs',
    hintEn: 'Show grants and prefs file',
  },
  {
    command: '/approve session shell|web',
    autocomplete: false,
    hintZh: '本会话授权 shell/web',
    hintEn: 'Grant shell/web for this session',
  },
  {
    command: '/approve always shell|web',
    autocomplete: false,
    hintZh: '持久授权写入 .tui-prefs.json',
    hintEn: 'Persist always grant to prefs',
  },
  {
    command: '/approve revoke always shell|web',
    autocomplete: false,
    hintZh: '撤销持久授权',
    hintEn: 'Revoke persisted always grant',
  },
  {
    command: '/skills',
    aliases: ['/skill'],
    hintZh: '选择并加载 skill',
    hintEn: 'Pick and load a skill',
  },
  {
    command: '/skills load <name>',
    autocomplete: false,
    hintZh: '加载指定 skill',
    hintEn: 'Load a skill by name',
  },
  {
    command: '/tools',
    aliases: ['/tool'],
    hintZh: '列出可用工具 + 宿主依赖探针',
    hintEn: 'List tools + host dependency probe',
  },
  {
    command: '/mcp list',
    hintZh: '列出已连接的 MCP 工具',
    hintEn: 'List connected MCP tools',
  },
  {
    command: '/workflow',
    aliases: ['/wf'],
    hintZh: '选择并武装 workflow',
    hintEn: 'Pick and arm a workflow',
  },
  {
    command: '/workflow !<name>',
    autocomplete: false,
    hintZh: '武装 workflow（下条输入为任务）',
    hintEn: 'Arm workflow for next line',
  },
  {
    command: '/workflow run <name> <task>',
    autocomplete: false,
    hintZh: '带检查点运行 workflow',
    hintEn: 'Run workflow with checkpoint',
  },
  {
    command: '/workflow <name> [task]',
    autocomplete: false,
    hintZh: '武装或立即运行 workflow',
    hintEn: 'Arm or run workflow',
  },
  {
    command: '/cwd <path>',
    hintZh: '切换工作目录',
    hintEn: 'Change working directory',
  },
  {
    command: '/stop',
    hintZh: '中止当前运行',
    hintEn: 'Abort current run',
  },
  {
    command: '/spawns',
    hintZh: '列出 spawn 预设',
    hintEn: 'List spawn_agent presets',
  },
  {
    command: '/jobs',
    hintZh: '后台 spawn job 列表',
    hintEn: 'List background spawn jobs',
  },
  {
    command: '/jobs status <job_id>',
    autocomplete: false,
    hintZh: '查看 job meta 与最近 events',
    hintEn: 'Show job meta and recent events',
  },
  {
    command: '/jobs tail <job_id>',
    autocomplete: false,
    hintZh: '滚动查看 job events',
    hintEn: 'Scroll job events log',
  },
  {
    command: '/help',
    aliases: ['/h', '?'],
    hintZh: '显示本帮助',
    hintEn: 'Show this help',
  },
];

function primaryCommandToken(entry: SlashHelpEntry): string {
  return entry.command.split(/\s+/)[0]!.toLowerCase();
}

function buildCommandAliases(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of SLASH_HELP_ENTRIES) {
    const primary = primaryCommandToken(entry);
    for (const alias of entry.aliases ?? []) {
      map[alias.toLowerCase()] = primary;
    }
  }
  return map;
}

const COMMAND_ALIASES: Record<string, string> = buildCommandAliases();

function formatBilingualHint(entry: SlashHelpEntry): string {
  return `${entry.hintZh} | ${entry.hintEn}`;
}

function formatSlashHelpLines(entries: SlashHelpEntry[]): string[] {
  const width = Math.max(...entries.map((e) => e.command.length), 16);
  return entries.map(
    (e) => `${e.command.padEnd(width)}  ${formatBilingualHint(e)}`,
  );
}

export const SLASH_HELP_LINES = formatSlashHelpLines(SLASH_HELP_ENTRIES);

export function slashAutocompleteItems(): Array<{ name: string; description: string }> {
  return SLASH_HELP_ENTRIES.filter((e) => e.autocomplete !== false).map((e) => ({
    name: e.autocompleteName ?? primaryCommandToken(e).slice(1),
    description: formatBilingualHint(e),
  }));
}

/** ASCII `/` plus common IME / keyboard variants (e.g. fullwidth ／). */
const SLASH_LEADER = /^[\u002F\uFF0F\uFE68\u2215]/;

/** Strip REPL prompt glyphs users sometimes paste with the command (e.g. `› /help`). */
export function normalizeReplInput(line: string): string {
  const stripped = line.trim().replace(/^[\u203A\u00BB\uFF1E>]+\s*/u, '').trim();
  if (stripped === '?') return '/help';
  return stripped;
}

export function isSlashCommand(line: string): boolean {
  return SLASH_LEADER.test(normalizeReplInput(line));
}

/** Normalize leading slash to ASCII `/` for parsing. */
export function normalizeSlashLine(line: string): string {
  const trimmed = line.trim();
  if (!SLASH_LEADER.test(trimmed)) return trimmed;
  return `/${trimmed.slice(1)}`;
}

function parseActionsSlash(parts: string[]): SlashResult {
  const id = parts[1];
  return {
    handled: true,
    message: id ? `__actions__:${id}` : '__actions__',
  };
}

function parseTranscriptSlash(parts: string[]): SlashResult {
  const id = parts[1];
  return {
    handled: true,
    message: id ? `__transcript__:${id}` : '__transcript__',
  };
}

function parseJobsSlash(parts: string[]): SlashResult {
  const sub = parts[1]?.toLowerCase();
  if (!sub) {
    return { handled: true, jobsAction: { kind: 'list' } };
  }
  const jobId = parts[2]?.trim();
  if (sub === 'status') {
    if (!jobId) {
      return { handled: true, message: 'Usage: /jobs status <job_id>' };
    }
    return { handled: true, jobsAction: { kind: 'status', jobId } };
  }
  if (sub === 'tail') {
    if (!jobId) {
      return { handled: true, message: 'Usage: /jobs tail <job_id>' };
    }
    return { handled: true, jobsAction: { kind: 'tail', jobId } };
  }
  return {
    handled: true,
    message: 'Usage: /jobs | /jobs status <job_id> | /jobs tail <job_id>',
  };
}

function parseBriefSlash(parts: string[]): SlashResult {
  const sub = parts[1]?.toLowerCase();
  if (sub === 'load') {
    const id = parts[2];
    return { handled: true, briefLoad: id ?? '' };
  }
  return { handled: true, briefWrite: true };
}

export function parseSlashLine(line: string): SlashResult | null {
  const input = normalizeReplInput(line);
  if (!isSlashCommand(input)) return null;

  const trimmed = normalizeSlashLine(input);
  const parts = trimmed.split(/\s+/).filter(Boolean);
  let cmd = (parts[0] ?? '').toLowerCase();
  cmd = COMMAND_ALIASES[cmd] ?? cmd;

  switch (cmd) {
    case '/quit':
      return { handled: true, quit: true };

    case '/stop':
      return { handled: true, stop: true };

    case '/help':
      return { handled: true, message: '__help__' };

    case '/sessions':
      return { handled: true, message: '__sessions__' };

    case '/new': {
      const sub = parts[1]?.toLowerCase();
      if (sub === 'brief') {
        return { handled: true, newSessionBrief: true };
      }
      if (sub === 'handoff') {
        return {
          handled: true,
          message: 'Unknown command: /new handoff (use /new brief)',
        };
      }
      return { handled: true, message: '__new__' };
    }

    case '/clear':
      return { handled: true, clearContext: true };

    case '/actions':
      return parseActionsSlash(parts);

    case '/transcript':
      return parseTranscriptSlash(parts);

    case '/brief':
      return parseBriefSlash(parts);

    case '/log':
      return {
        handled: true,
        message: 'Unknown command: /log (use /actions)',
      };

    case '/history':
      return {
        handled: true,
        message: 'Unknown command: /history (use /transcript)',
      };

    case '/handoff':
      return {
        handled: true,
        message: 'Unknown command: /handoff (use /brief — session summary, not git transfer)',
      };

    case '/memory': {
      const parsed = parseMemorySlash(parts);
      if (typeof parsed === 'string') {
        return { handled: true, memoryMessage: parsed };
      }
      return { handled: true, memoryAction: parsed };
    }

    case '/resume': {
      const id = parts[1];
      if (!id || id.toLowerCase() === 'last') {
        return { handled: true, message: '__resume_last__' };
      }
      return { handled: true, message: `__resume__:${id}` };
    }

    case '/profile': {
      const sub = parts[1]?.trim();
      if (!sub) {
        return { handled: true, llmAction: { kind: 'profile', mode: 'list' } };
      }
      if (sub.toLowerCase() === 'reset') {
        return { handled: true, llmAction: { kind: 'profile', mode: 'reset' } };
      }
      return {
        handled: true,
        llmAction: { kind: 'profile', mode: 'set', name: sub },
      };
    }

    case '/model': {
      const sub = parts.slice(1).join(' ').trim();
      if (!sub) {
        return { handled: true, llmAction: { kind: 'model', mode: 'list' } };
      }
      if (sub.toLowerCase() === 'reset') {
        return { handled: true, llmAction: { kind: 'model', mode: 'reset' } };
      }
      return {
        handled: true,
        llmAction: { kind: 'model', mode: 'set', model: sub },
      };
    }

    case '/reasoning': {
      const sub = parts[1]?.trim();
      if (!sub) {
        return { handled: true, llmAction: { kind: 'reasoning', mode: 'list' } };
      }
      if (sub.toLowerCase() === 'reset') {
        return { handled: true, llmAction: { kind: 'reasoning', mode: 'reset' } };
      }
      return {
        handled: true,
        llmAction: { kind: 'reasoning', mode: 'set', level: sub },
      };
    }

    case '/shell': {
      const mode = parts[1]?.toLowerCase();
      if (!mode) return { handled: true, message: '__shell_status__' };
      if (mode !== 'on' && mode !== 'off') {
        return { handled: true, message: 'Usage: /shell on|off' };
      }
      return { handled: true, message: `__shell__:${mode}` };
    }

    case '/web': {
      const mode = parts[1]?.toLowerCase();
      if (!mode) return { handled: true, message: '__web_status__' };
      if (mode !== 'on' && mode !== 'off') {
        return { handled: true, message: 'Usage: /web on|off' };
      }
      return { handled: true, message: `__web__:${mode}` };
    }

    case '/approve': {
      const sub = parts[1]?.toLowerCase();
      if (!sub || sub === 'status') {
        return { handled: true, approveAction: { type: 'status' } };
      }
      if (sub === 'session' || sub === 'always') {
        const kind = parts[2]?.toLowerCase();
        if (kind !== 'shell' && kind !== 'web') {
          return {
            handled: true,
            message: `Usage: /approve ${sub} shell|web`,
          };
        }
        return {
          handled: true,
          approveAction: { type: sub, kind: kind as ApproveKind },
        };
      }
      if (sub === 'revoke' && parts[2]?.toLowerCase() === 'always') {
        const kind = parts[3]?.toLowerCase();
        if (kind !== 'shell' && kind !== 'web') {
          return {
            handled: true,
            message: 'Usage: /approve revoke always shell|web',
          };
        }
        return {
          handled: true,
          approveAction: { type: 'revoke', kind: kind as ApproveKind },
        };
      }
      return {
        handled: true,
        message: 'Usage: /approve status|session|always|revoke always',
      };
    }

    case '/skills': {
      if (parts[1]?.toLowerCase() === 'load') {
        const name = parts[2];
        if (!name) return { handled: true, message: 'Usage: /skills load <name>' };
        return { handled: true, message: `__skill_load__:${name}` };
      }
      return { handled: true, message: '__skills__' };
    }

    case '/tools':
      return { handled: true, message: '__tools__' };

    case '/mcp': {
      const sub = parts[1]?.toLowerCase();
      if (!sub || sub === 'list') {
        return { handled: true, message: '__mcp_list__' };
      }
      return { handled: true, message: 'Usage: /mcp list' };
    }

    case '/spawns':
      return { handled: true, spawnsAction: { kind: 'list' } };

    case '/jobs':
      return parseJobsSlash(parts);

    case '/cwd': {
      const path = parts.slice(1).join(' ');
      if (!path) return { handled: true, message: 'Usage: /cwd <path>' };
      return { handled: true, message: `__cwd__:${path}` };
    }

    case '/workflow': {
      if (parts.length === 1) {
        return { handled: true, message: '__workflow_list__' };
      }
      const sub = parts[1];
      if (sub.toLowerCase() === 'run') {
        const name = parts[2];
        const task = parts.slice(3).join(' ');
        if (!name || !task) {
          return { handled: true, message: 'Usage: /workflow run <name> <task>' };
        }
        return { handled: true, runWorkflow: { path: name, task } };
      }
      if (sub.startsWith('!')) {
        const name = sub.slice(1);
        if (!name) return { handled: true, message: 'Usage: /workflow !<name>' };
        return { handled: true, armWorkflow: name };
      }
      const nameOrPath = sub;
      const task = parts.slice(2).join(' ');
      if (!task) {
        return { handled: true, armWorkflow: nameOrPath };
      }
      return { handled: true, runWorkflow: { path: nameOrPath, task } };
    }

    case '/session':
      return {
        handled: true,
        message: 'Unknown command: /session (use /sessions)',
      };

    case '/provider':
      return {
        handled: true,
        message: 'Unknown command: /provider (use /profile)',
      };

    default:
      return {
        handled: true,
        message: `Unknown command: ${cmd} (try /help)`,
      };
  }
}