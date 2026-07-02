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
  borderColor: (text: string) => chalk.dim(text),
  selectList: piSelectListTheme,
};

export const piChalk = chalk;