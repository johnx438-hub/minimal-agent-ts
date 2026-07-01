import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

let instance: Marked | null = null;
let lastWidth = 0;

function terminalWidth(): number {
  return Math.max(40, (process.stdout.columns ?? 100) - 2);
}

function getMarked(): Marked {
  const width = terminalWidth();
  if (!instance || width !== lastWidth) {
    instance = new Marked();
    instance.use(
      markedTerminal({
        width,
        reflowText: true,
        showSectionPrefix: false,
      }),
    );
    lastWidth = width;
  }
  return instance;
}

export function resetMarkdownTerminal(): void {
  instance = null;
  lastWidth = 0;
}

const SKIP_FORMAT = /^\[(aborted|Agent stopped:)/;

export function shouldFormatFinal(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (SKIP_FORMAT.test(t)) return false;
  if (process.env.TUI_MARKDOWN === '0') return false;
  return true;
}

/** Markdown → ANSI for terminal (headings, emphasis, tables, code). */
export function renderMarkdownForTerminal(text: string): string {
  const out = getMarked().parse(text);
  return typeof out === 'string' ? out.trimEnd() : text;
}