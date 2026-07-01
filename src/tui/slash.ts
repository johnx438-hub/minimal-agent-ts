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

/** ASCII `/` plus common IME / keyboard variants (e.g. fullwidth ／). */
const SLASH_LEADER = /^[\u002F\uFF0F\uFE68\u2215]/;

const COMMAND_ALIASES: Record<string, string> = {
  '/session': '/sessions',
  '/skill': '/skills',
  '/tool': '/tools',
  '/wf': '/workflow',
  '/h': '/help',
  '?': '/help',
  '/r': '/resume',
};

export const SLASH_HELP_LINES = [
  '/sessions          list saved sessions',
  '/resume [id|last]  resume session (omit id = most recent)',
  '/new               new session',
  '/new handoff       write handoff, new session, queue load',
  '/handoff           write handoff file for current session',
  '/handoff load [id] queue handoff for next task',
  '/clear             clear in-flight context (keep task summaries)',
  '/quit              exit TUI',
  '/shell on|off      toggle run_shell (session only, not saved)',
  '/web on|off        toggle web_fetch (session only, not saved)',
  '/approve status    show prefs file + always grants',
  '/approve session shell|web   grant for this session',
  '/approve always shell|web    persist always to .tui-prefs.json',
  '/approve revoke always shell|web',
  '/skills            list skills',
  '/skills load <n>   load skill',
  '/tools             list tools',
  '/workflow          list workflows',
  '/workflow !<n>     arm workflow for next line',
  '/workflow run <n> <task>  run with checkpoint',
  '/workflow <n> [task]  arm or run workflow',
  '/cwd <path>        change cwd',
  '/stop              abort current run',
  '/spawns            list spawn_agent presets',
  '/help              this list',
];

/** Strip REPL prompt glyphs users sometimes paste with the command (e.g. `› /help`). */
export function normalizeReplInput(line: string): string {
  return line.trim().replace(/^[\u203A\u00BB\uFF1E>]+\s*/u, '').trim();
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