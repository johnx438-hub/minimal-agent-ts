import { Chalk } from 'chalk';
import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui';

const chalk = new Chalk({ level: 3 });

export const piSelectListTheme: SelectListTheme = {
  selectedPrefix: (text: string) => chalk.blue(text),
  selectedText: (text: string) => chalk.bold(text),
  description: (text: string) => chalk.dim(text),
  scrollInfo: (text: string) => chalk.dim(text),
  noMatch: (text: string) => chalk.dim(text),
};

/** Overlay panel background — keep in sync with select-overlay.ts */
export const piOverlayBgHex = '#1e1e2e';

function overlayBg(text: string): string {
  return chalk.bgHex(piOverlayBgHex)(chalk.white(text));
}

function overlayStyle(styler: (text: string) => string): (text: string) => string {
  return (text: string) => overlayBg(styler(text));
}

/** SelectList theme with per-span background (avoids SGR reset gaps in overlays). */
export const piSelectListOverlayTheme: SelectListTheme = {
  selectedPrefix: overlayStyle((text) => chalk.blue(text)),
  selectedText: overlayStyle((text) => chalk.bold(text)),
  description: overlayStyle((text) => chalk.dim(text)),
  scrollInfo: overlayStyle((text) => chalk.dim(text)),
  noMatch: overlayStyle((text) => chalk.dim(text)),
};

function highlightDiffLine(line: string): string {
  if (line.startsWith('@@')) return chalk.cyan(line);
  if (line.startsWith('+++')) return chalk.green.bold(line);
  if (line.startsWith('---')) return chalk.red.bold(line);
  if (line.startsWith('+ ')) return chalk.green(line);
  if (line.startsWith('- ')) return chalk.red(line);
  if (line.startsWith('+')) return chalk.green(line);
  if (line.startsWith('-')) return chalk.red(line);
  return chalk.dim(line);
}

export const piMarkdownTheme: MarkdownTheme = {
  heading: (text: string) => chalk.bold.cyan(text),
  link: (text: string) => chalk.blue(text),
  linkUrl: (text: string) => chalk.dim(text),
  code: (text: string) => chalk.yellow(text),
  codeBlock: (text: string) => chalk.green(text),
  codeBlockBorder: (text: string) => chalk.dim(text),
  highlightCode: (code: string, lang?: string) => {
    if (lang === 'diff') {
      return code.split('\n').map(highlightDiffLine);
    }
    return code.split('\n').map((line) => chalk.green(line));
  },
  quote: (text: string) => chalk.italic(text),
  quoteBorder: (text: string) => chalk.dim(text),
  hr: (text: string) => chalk.dim(text),
  listBullet: (text: string) => chalk.cyan(text),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  strikethrough: (text: string) => chalk.strikethrough(text),
  underline: (text: string) => chalk.underline(text),
};

export const piEditorTheme: EditorTheme = {
  borderColor: (text: string) => chalk.gray(text),
  selectList: piSelectListTheme,
};

export const piChalk = chalk;

/** Semantic stylers for chat scrollback (SPEC_TUI_POLISH §4.1). */
export type TextStyler = (text: string) => string;

export const piSemantic = {
  userLine: (text: string) => chalk.bold.white(text),
  metaLine: (text: string) => chalk.dim(text),
  toolOk: (text: string) => chalk.green(text),
  toolErr: (text: string) => chalk.red(text),
  toolRunning: (text: string) => chalk.cyan(text),
  statusOk: (text: string) => chalk.green(text),
  statusErr: (text: string) => chalk.red(text),
  accent: (text: string) => chalk.cyan(text),
  statusBar: (text: string) => chalk.dim(text),
  hint: (text: string) => chalk.dim(text),
} as const satisfies Record<string, TextStyler>;
