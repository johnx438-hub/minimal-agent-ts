export interface SlashResult {
  handled: boolean;
  message?: string;
  quit?: boolean;
  runTask?: string;
  runWorkflow?: { path: string; task: string };
  armWorkflow?: string | null;
  stop?: boolean;
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
  '/quit              exit TUI',
  '/shell on|off      toggle run_shell',
  '/web on|off        toggle web_fetch',
  '/skills            list skills',
  '/skills load <n>   load skill',
  '/tools             list tools',
  '/workflow          list workflows',
  '/workflow <n> [task]  arm or run workflow',
  '/cwd <path>        change cwd',
  '/stop              abort current run',
  '/spawns            list spawn_agent presets',
  '/help              this list',
];

export function isSlashCommand(line: string): boolean {
  return SLASH_LEADER.test(line.trim());
}

/** Normalize leading slash to ASCII `/` for parsing. */
export function normalizeSlashLine(line: string): string {
  const trimmed = line.trim();
  if (!SLASH_LEADER.test(trimmed)) return trimmed;
  return `/${trimmed.slice(1)}`;
}

export function parseSlashLine(line: string): SlashResult | null {
  if (!isSlashCommand(line)) return null;

  const trimmed = normalizeSlashLine(line);
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

    case '/new':
      return { handled: true, message: '__new__' };

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
      const nameOrPath = parts[1];
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