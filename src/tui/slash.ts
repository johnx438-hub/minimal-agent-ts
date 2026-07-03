export type ApproveKind = 'shell' | 'web';

export type ApproveAction =
  | { type: 'status' }
  | { type: 'session'; kind: ApproveKind }
  | { type: 'always'; kind: ApproveKind }
  | { type: 'revoke'; kind: ApproveKind };

export interface SlashResult {
  handled: boolean;
  message?: string;
  quit?: boolean;
  runTask?: string;
  runWorkflow?: { path: string; task: string };
  armWorkflow?: string | null;
  stop?: boolean;
  newSessionHandoff?: boolean;
  clearContext?: boolean;
  handoffWrite?: boolean;
  /** Session id to load; omit = current session. */
  handoffLoad?: string;
  approveAction?: ApproveAction;
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
    aliases: ['/session'],
    hintZh: '选择并恢复已保存会话',
    hintEn: 'Pick and resume a saved session',
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
    command: '/new handoff',
    autocomplete: false,
    hintZh: '写交接并新建会话',
    hintEn: 'Write handoff, new session, queue load',
  },
  {
    command: '/handoff',
    hintZh: '为当前会话写交接文件',
    hintEn: 'Write handoff file for current session',
  },
  {
    command: '/handoff load [id]',
    autocomplete: false,
    hintZh: '排队加载交接（下条任务注入）',
    hintEn: 'Queue handoff for next task',
  },
  {
    command: '/log [session_id]',
    hintZh: '审计当前会话任务与工具调用',
    hintEn: 'Audit task and tool actions in session',
  },
  {
    command: '/history [session_id]',
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
    hintZh: '列出可用工具',
    hintEn: 'List available tools',
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
      if (parts[1]?.toLowerCase() === 'handoff') {
        return { handled: true, newSessionHandoff: true };
      }
      return { handled: true, message: '__new__' };
    }

    case '/clear':
      return { handled: true, clearContext: true };

    case '/log': {
      const id = parts[1];
      return {
        handled: true,
        message: id ? `__log__:${id}` : '__log__',
      };
    }

    case '/history': {
      const id = parts[1];
      return {
        handled: true,
        message: id ? `__history__:${id}` : '__history__',
      };
    }

    case '/handoff': {
      const sub = parts[1]?.toLowerCase();
      if (sub === 'load') {
        const id = parts[2];
        return { handled: true, handoffLoad: id ?? '' };
      }
      return { handled: true, handoffWrite: true };
    }

    case '/resume': {
      const id = parts[1];
      if (!id || id.toLowerCase() === 'last') {
        return { handled: true, message: '__resume_last__' };
      }
      return { handled: true, message: `__resume__:${id}` };
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
      return { handled: true, message: '__spawns__' };

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

    default:
      return {
        handled: true,
        message: `Unknown command: ${cmd} (try /help)`,
      };
  }
}