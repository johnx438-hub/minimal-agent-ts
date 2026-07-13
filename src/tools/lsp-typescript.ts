/**
 * In-process TypeScript LanguageService backend for lsp_query (C2).
 * Used when typescript package is available (project already depends on it via tsx).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type ts from 'typescript';

const requireTs = createRequire(import.meta.url);

export type LspOperation = 'hover' | 'definition' | 'references' | 'symbols';

export interface LspQueryRequest {
  cwd: string;
  path: string;
  /** 1-based line */
  line: number;
  /** 1-based character, default 1 */
  character: number;
  operation: LspOperation;
}

export interface LspLocation {
  path: string;
  line: number;
  character: number;
  endLine?: number;
  endCharacter?: number;
  text?: string;
}

export interface LspQueryResult {
  operation: LspOperation;
  path: string;
  line: number;
  character: number;
  backend: 'typescript-api';
  items: LspLocation[];
  hover?: string;
  note?: string;
}

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

export function isTypeScriptLikePath(filePath: string): boolean {
  return TS_EXTS.has(extname(filePath).toLowerCase());
}

function walkTsFiles(root: string, maxFiles = 400): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.sessions']);

  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && isTypeScriptLikePath(full)) {
        out.push(full);
        if (out.length >= maxFiles) return;
      }
    }
  };

  walk(root);
  return out;
}

function loadTs(): typeof ts {
  return requireTs('typescript') as typeof ts;
}

function lineCharToPos(
  tsApi: typeof ts,
  sourceFile: ts.SourceFile,
  line: number,
  character: number,
): number {
  const l = Math.max(0, line - 1);
  const c = Math.max(0, character - 1);
  return tsApi.getPositionOfLineAndCharacter(sourceFile, l, c);
}

function posToLoc(
  tsApi: typeof ts,
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
  cwd: string,
  text?: string,
): LspLocation {
  const startLc = tsApi.getLineAndCharacterOfPosition(sourceFile, start);
  const endLc = tsApi.getLineAndCharacterOfPosition(sourceFile, end);
  return {
    path: relative(cwd, sourceFile.fileName) || sourceFile.fileName,
    line: startLc.line + 1,
    character: startLc.character + 1,
    endLine: endLc.line + 1,
    endCharacter: endLc.character + 1,
    text,
  };
}

function createLanguageService(
  tsApi: typeof ts,
  cwd: string,
  focusFile: string,
): { service: ts.LanguageService; cleanup: () => void } {
  const configPath = tsApi.findConfigFile(cwd, tsApi.sys.fileExists, 'tsconfig.json');
  let options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    target: tsApi.ScriptTarget.ES2022,
    module: tsApi.ModuleKind.NodeNext,
    moduleResolution: tsApi.ModuleResolutionKind.NodeNext,
    jsx: tsApi.JsxEmit.ReactJSX,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
  };
  let rootNames: string[] = [];

  if (configPath) {
    const configFile = tsApi.readConfigFile(configPath, tsApi.sys.readFile);
    const parsed = tsApi.parseJsonConfigFileContent(
      configFile.config,
      tsApi.sys,
      dirname(configPath),
    );
    options = { ...parsed.options, skipLibCheck: true };
    rootNames = parsed.fileNames;
  }

  if (!rootNames.includes(focusFile)) {
    rootNames = [...rootNames, focusFile];
  }

  // Cap program size for agent responsiveness when no project list.
  if (rootNames.length === 0 || rootNames.length > 500) {
    const walked = walkTsFiles(cwd, 400);
    if (!walked.includes(focusFile)) walked.push(focusFile);
    rootNames = walked;
  }

  const scriptVersions = new Map<string, string>();
  const fileExists = (f: string) => tsApi.sys.fileExists(f);
  const readFile = (f: string) => tsApi.sys.readFile(f);

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => rootNames,
    getScriptVersion: (fileName) => scriptVersions.get(fileName) ?? '1',
    getScriptSnapshot: (fileName) => {
      if (!fileExists(fileName)) return undefined;
      const text = readFile(fileName);
      if (text === undefined) return undefined;
      return tsApi.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => cwd,
    getDefaultLibFileName: (opts) => tsApi.getDefaultLibFilePath(opts),
    fileExists,
    readFile,
    readDirectory: tsApi.sys.readDirectory,
    directoryExists: tsApi.sys.directoryExists,
    getDirectories: tsApi.sys.getDirectories,
    realpath: tsApi.sys.realpath,
  };

  const service = tsApi.createLanguageService(host, tsApi.createDocumentRegistry());
  return {
    service,
    cleanup: () => service.dispose(),
  };
}

export function runTypeScriptLspQuery(req: LspQueryRequest): LspQueryResult | { error: string } {
  let tsApi: typeof ts;
  try {
    tsApi = loadTs();
  } catch {
    return {
      error:
        'error: typescript package not available. Install typescript or typescript-language-server for lsp_query.',
    };
  }

  const absPath = resolve(req.path);
  if (!existsSync(absPath)) {
    return { error: `error: file not found: ${req.path}` };
  }
  if (!isTypeScriptLikePath(absPath)) {
    return {
      error: `error: no TypeScript/JS language service for extension ${extname(absPath) || '(none)'}. Install a language server mapping or use .ts/.tsx/.js files.`,
    };
  }

  const { service, cleanup } = createLanguageService(tsApi, req.cwd, absPath);
  try {
    const program = service.getProgram();
    const sourceFile = program?.getSourceFile(absPath);
    if (!sourceFile) {
      return { error: `error: failed to load source file into language service: ${req.path}` };
    }

    let pos: number;
    try {
      pos = lineCharToPos(tsApi, sourceFile, req.line, req.character);
    } catch {
      return { error: `error: invalid line/character ${req.line}:${req.character}` };
    }

    const rel = relative(req.cwd, absPath) || absPath;
    const base = {
      operation: req.operation,
      path: rel,
      line: req.line,
      character: req.character,
      backend: 'typescript-api' as const,
    };

    if (req.operation === 'hover') {
      const info = service.getQuickInfoAtPosition(absPath, pos);
      if (!info) {
        return { ...base, items: [], note: 'no hover info at position' };
      }
      const display = tsApi.displayPartsToString(info.displayParts);
      const docs = tsApi.displayPartsToString(info.documentation);
      const hover = docs ? `${display}\n\n${docs}` : display;
      return {
        ...base,
        items: [posToLoc(tsApi, sourceFile, info.textSpan.start, info.textSpan.start + info.textSpan.length, req.cwd)],
        hover,
      };
    }

    if (req.operation === 'definition') {
      const defs = service.getDefinitionAtPosition(absPath, pos) ?? [];
      const items: LspLocation[] = [];
      for (const d of defs) {
        const sf = program?.getSourceFile(d.fileName);
        if (!sf) {
          items.push({
            path: relative(req.cwd, d.fileName) || d.fileName,
            line: 1,
            character: 1,
            text: d.name,
          });
          continue;
        }
        items.push(
          posToLoc(
            tsApi,
            sf,
            d.textSpan.start,
            d.textSpan.start + d.textSpan.length,
            req.cwd,
            d.name,
          ),
        );
      }
      return {
        ...base,
        items,
        note: items.length === 0 ? 'no definition at position' : undefined,
      };
    }

    if (req.operation === 'references') {
      const refs = service.getReferencesAtPosition(absPath, pos) ?? [];
      const items: LspLocation[] = [];
      for (const r of refs) {
        // Skip pure write/definition sites when there are also read sites.
        const sf = program?.getSourceFile(r.fileName);
        if (!sf) continue;
        items.push(
          posToLoc(
            tsApi,
            sf,
            r.textSpan.start,
            r.textSpan.start + r.textSpan.length,
            req.cwd,
            r.isWriteAccess ? 'write' : 'read',
          ),
        );
      }
      return {
        ...base,
        items,
        note: items.length === 0 ? 'no references at position' : undefined,
      };
    }

    // symbols — document outline
    const nav = service.getNavigationTree(absPath);
    const items: LspLocation[] = [];
    const walk = (node: ts.NavigationTree, depth: number): void => {
      const label = node.text?.trim() ?? '';
      if (depth > 0 && label && node.spans[0]) {
        const span = node.spans[0];
        items.push(
          posToLoc(
            tsApi,
            sourceFile,
            span.start,
            span.start + span.length,
            req.cwd,
            `${node.kind}: ${label}`,
          ),
        );
      }
      for (const child of node.childItems ?? []) walk(child, depth + 1);
    };
    walk(nav, 0);
    return {
      ...base,
      items,
      note: items.length === 0 ? 'no document symbols' : `${items.length} symbols`,
    };
  } finally {
    cleanup();
  }
}

export function formatLspQueryMarkdown(result: LspQueryResult): string {
  const lines: string[] = [
    `### lsp_query \`${result.operation}\` @ \`${result.path}:${result.line}:${result.character}\``,
    `backend: ${result.backend}`,
  ];
  if (result.hover) {
    lines.push('', '**Hover**', '```ts', result.hover, '```');
  }
  if (result.items.length > 0) {
    lines.push('', '**Results**');
    for (const item of result.items.slice(0, 50)) {
      const range =
        item.endLine !== undefined
          ? `${item.line}:${item.character}-${item.endLine}:${item.endCharacter ?? item.character}`
          : `${item.line}:${item.character}`;
      const label = item.text ? ` — ${item.text}` : '';
      lines.push(`- \`${item.path}:${range}\`${label}`);
    }
    if (result.items.length > 50) {
      lines.push(`- … +${result.items.length - 50} more`);
    }
  }
  if (result.note) {
    lines.push('', `_${result.note}_`);
  }
  return lines.join('\n');
}

/** file:// URI helper for future stdio LSP bridge. */
export function pathToUri(absPath: string): string {
  return pathToFileURL(absPath).href;
}

export function readFileText(absPath: string): string {
  return readFileSync(absPath, 'utf8');
}
