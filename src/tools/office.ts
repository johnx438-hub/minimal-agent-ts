/**
 * Office tools (Node-only): docx/pptx first-class; xlsx read + light edit.
 * No shell / no external CLI.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

import { createRequire } from 'node:module';

import { Document, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';

// pptxgenjs is CJS; ESM default interop is unreliable across Node loaders.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PptxGenJS = require('pptxgenjs') as new () => {
  author: string;
  title: string;
  addSlide: () => {
    addText: (text: unknown, opts: Record<string, unknown>) => void;
  };
  write: (opts: { outputType: string }) => Promise<Buffer | Uint8Array | string>;
};

import type { AgentConfig, ToolDefinition } from '../types.js';
import { resolveReadablePath, resolveWritablePath } from './path-utils.js';

const DEFAULT_MAX_CHARS = 24_000;
const MAX_MAX_CHARS = 120_000;
const DEFAULT_XLSX_MAX_ROWS = 50;
const MAX_XLSX_MAX_ROWS = 500;
const SPILL_THRESHOLD = 12_000;
/** Reject Office files larger than this before parsing (zip-bomb / DoS guard). */
export const MAX_OFFICE_FILE_BYTES = 40 * 1024 * 1024;
/** Max entries inside a pptx/zip archive we will enumerate. */
export const MAX_ZIP_ENTRIES = 400;
/** Max total uncompressed slide XML we will load from a pptx. */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

export const OFFICE_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'office_read',
      description:
        'Read an Office file under the project cwd (docx / pptx / xlsx) into a text summary for the agent. ' +
        'docx: body text; pptx: per-slide outline; xlsx: sheet names + sampled rows. ' +
        'Large output may spill under .cache/office/. Pure Node — no shell.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path relative to cwd (or absolute under allowed roots).',
          },
          format: {
            type: 'string',
            description: 'markdown (default) or json summary.',
            enum: ['markdown', 'json'],
          },
          max_chars: {
            type: 'number',
            description: `Inline cap (default ${DEFAULT_MAX_CHARS}).`,
          },
          sheet: {
            type: 'string',
            description: 'xlsx only: sheet name (default first sheet).',
          },
          max_rows: {
            type: 'number',
            description: `xlsx only: max data rows to sample (default ${DEFAULT_XLSX_MAX_ROWS}).`,
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'office_write',
      description:
        'Create or lightly update Office files under cwd. ' +
        'docx: write simple paragraphs (create/overwrite). ' +
        'pptx: write title + bullet slides (create/overwrite). ' +
        'xlsx: light edit only — append_rows, set_cells, or replace one sheet (create if missing). ' +
        'Pure Node — no shell. Prefer for structured docs over raw XML.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Output path relative to cwd (extension selects format).',
          },
          paragraphs: {
            type: 'array',
            items: { type: 'string' },
            description: 'docx: list of paragraph strings.',
          },
          text: {
            type: 'string',
            description: 'docx: whole body; split on blank lines into paragraphs if paragraphs omitted.',
          },
          title: {
            type: 'string',
            description: 'pptx: presentation title (first slide if no slides).',
          },
          slides: {
            type: 'array',
            description: 'pptx: slides with title and bullets.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                bullets: { type: 'array', items: { type: 'string' } },
                body: { type: 'string' },
              },
            },
          },
          sheet: {
            type: 'string',
            description: 'xlsx: target sheet name (default Sheet1).',
          },
          append_rows: {
            type: 'array',
            description: 'xlsx: rows to append (each row is array of cell values).',
            items: { type: 'array', items: {} },
          },
          set_cells: {
            type: 'array',
            description: 'xlsx: set individual cells, e.g. [{ cell: "A1", value: "hi" }].',
            items: {
              type: 'object',
              properties: {
                cell: { type: 'string' },
                value: {},
              },
            },
          },
          replace_sheet: {
            type: 'boolean',
            description:
              'xlsx: if true with append_rows, clear sheet first then write rows (default false = append).',
          },
          headers: {
            type: 'array',
            items: { type: 'string' },
            description: 'xlsx: optional header row when creating/replacing a sheet.',
          },
        },
        required: ['path'],
      },
    },
  },
];

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function detectOfficeKind(path: string): OfficeKind | null {
  const ext = extname(path).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
  if (ext === '.pptx') return 'pptx';
  return null;
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars - 1)}…`, truncated: true };
}

function ensureOfficeCacheDir(cwd: string): string {
  const dir = resolve(cwd, '.cache', 'office');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function spillIfNeeded(
  cwd: string,
  sourcePath: string,
  body: string,
  maxChars: number,
): { inline: string; spillRel?: string } {
  if (body.length <= SPILL_THRESHOLD && body.length <= maxChars) {
    const t = truncate(body, maxChars);
    return { inline: t.text };
  }
  const dir = ensureOfficeCacheDir(cwd);
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 12);
  const base = basename(sourcePath).replace(/[^\w.-]+/g, '_') || 'doc';
  const spillName = `${base}.${hash}.md`;
  const abs = join(dir, spillName);
  writeFileSync(abs, body, 'utf8');
  const rel = relative(cwd, abs).replace(/\\/g, '/');
  const preview = truncate(body, Math.min(maxChars, 4_000));
  return {
    inline:
      `${preview.text}\n\n---\n` +
      `[office_spill] full text: ${rel} (${body.length} chars). Use read_file with offset/limit.`,
    spillRel: rel,
  };
}

// ─── DOCX ───────────────────────────────────────────────────────────────────

export async function readDocxBuffer(buf: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: buf });
  const text = (result.value ?? '').replace(/\r\n/g, '\n').trim();
  return text || '(empty document)';
}

async function writeDocxFile(
  absPath: string,
  paragraphs: string[],
): Promise<void> {
  const paras =
    paragraphs.length > 0
      ? paragraphs
      : ['(empty)'];
  const doc = new Document({
    sections: [
      {
        children: paras.map(
          (p) =>
            new Paragraph({
              children: [new TextRun(p)],
            }),
        ),
      },
    ],
  });
  const buffer = await Packer.toBuffer(doc);
  writeFileSync(absPath, buffer);
}

// ─── XLSX ───────────────────────────────────────────────────────────────────

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null && 'text' in value) {
    return String((value as { text: unknown }).text ?? '');
  }
  if (typeof value === 'object' && value !== null && 'result' in value) {
    return String((value as { result: unknown }).result ?? '');
  }
  return String(value);
}

export async function readXlsxFile(
  absPath: string,
  opts: { sheet?: string; maxRows: number },
): Promise<{ markdown: string; json: Record<string, unknown> }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(absPath);
  const names = wb.worksheets.map((ws) => ws.name);
  if (names.length === 0) {
    return { markdown: '(workbook has no sheets)', json: { sheets: [] } };
  }
  const sheetName = opts.sheet?.trim() || names[0]!;
  const ws = wb.getWorksheet(sheetName);
  if (!ws) {
    return {
      markdown: `error: sheet not found: ${sheetName}\nAvailable: ${names.join(', ')}`,
      json: { sheets: names, error: 'sheet_not_found' },
    };
  }

  const rows: string[][] = [];
  let totalRows = 0;
  ws.eachRow({ includeEmpty: false }, (row) => {
    totalRows += 1;
    if (rows.length >= opts.maxRows) return;
    const values = row.values;
    const arr = Array.isArray(values) ? values.slice(1) : [];
    rows.push(arr.map(cellToString));
  });

  const mdLines = [
    `# Spreadsheet: ${basename(absPath)}`,
    '',
    `Sheets: ${names.join(', ')}`,
    `Active: ${sheetName} (sampled ${rows.length}/${totalRows} rows)`,
    '',
    '| ' +
      (rows[0]?.map((_, i) => `C${i + 1}`).join(' | ') || 'empty') +
      ' |',
  ];
  if (rows[0]) {
    mdLines.push('| ' + rows[0].map(() => '---').join(' | ') + ' |');
  }
  for (const r of rows) {
    mdLines.push(
      '| ' + r.map((c) => c.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |',
    );
  }
  if (totalRows > rows.length) {
    mdLines.push('', `… ${totalRows - rows.length} more row(s) not shown (raise max_rows).`);
  }

  return {
    markdown: mdLines.join('\n'),
    json: {
      sheets: names,
      sheet: sheetName,
      total_rows: totalRows,
      sample_rows: rows,
    },
  };
}

export async function writeXlsxLight(
  absPath: string,
  opts: {
    sheet: string;
    appendRows?: unknown[][];
    setCells?: Array<{ cell: string; value: unknown }>;
    replaceSheet?: boolean;
    headers?: string[];
  },
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  if (existsSync(absPath)) {
    await wb.xlsx.readFile(absPath);
  }

  let ws = wb.getWorksheet(opts.sheet);
  if (!ws) {
    ws = wb.addWorksheet(opts.sheet);
  }

  if (opts.replaceSheet) {
    ws.spliceRows(1, ws.rowCount || 1);
  }

  if (opts.headers?.length && (opts.replaceSheet || ws.rowCount === 0)) {
    ws.addRow(opts.headers);
  }

  if (opts.appendRows?.length) {
    for (const row of opts.appendRows) {
      ws.addRow(row.map((c) => (c === undefined ? null : c)));
    }
  }

  if (opts.setCells?.length) {
    for (const item of opts.setCells) {
      const addr = String(item.cell ?? '').trim();
      if (!addr) continue;
      ws.getCell(addr).value = item.value as ExcelJS.CellValue;
    }
  }

  await wb.xlsx.writeFile(absPath);
  const bits = [
    `ok: wrote ${basename(absPath)}`,
    `sheet=${opts.sheet}`,
    opts.replaceSheet ? 'mode=replace' : 'mode=update',
    opts.appendRows?.length ? `appended_rows=${opts.appendRows.length}` : '',
    opts.setCells?.length ? `set_cells=${opts.setCells.length}` : '',
  ].filter(Boolean);
  return bits.join(' · ');
}

// ─── PPTX ───────────────────────────────────────────────────────────────────

function extractTextFromSlideXml(xml: string): string[] {
  const texts: string[] = [];
  const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const t = m[1]!
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    if (t) texts.push(t);
  }
  return texts;
}

export async function readPptxBuffer(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf, { checkCRC32: true });
  const allNames = Object.keys(zip.files);
  if (allNames.length > MAX_ZIP_ENTRIES) {
    throw new Error(
      `pptx has too many zip entries (${allNames.length} > ${MAX_ZIP_ENTRIES})`,
    );
  }

  const slidePaths = allNames
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n) && !zip.files[n]!.dir)
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)/i)?.[1] ?? 0);
      const nb = Number(b.match(/slide(\d+)/i)?.[1] ?? 0);
      return na - nb;
    });

  if (slidePaths.length === 0) {
    return '(presentation has no slides or unreadable structure)';
  }

  const lines = [`# Presentation (${slidePaths.length} slides)`, ''];
  let uncompressed = 0;
  for (let i = 0; i < slidePaths.length; i++) {
    const entry = zip.files[slidePaths[i]!]!;
    const xml = await entry.async('string');
    uncompressed += Buffer.byteLength(xml, 'utf8');
    if (uncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new Error(
        `pptx slide XML exceeds uncompressed budget (${MAX_ZIP_UNCOMPRESSED_BYTES} bytes)`,
      );
    }
    const texts = extractTextFromSlideXml(xml);
    lines.push(`## Slide ${i + 1}`);
    if (texts.length === 0) lines.push('(no text)');
    else for (const t of texts) lines.push(`- ${t}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function writePptxFile(
  absPath: string,
  opts: {
    title?: string;
    slides: Array<{ title?: string; bullets?: string[]; body?: string }>;
  },
): Promise<void> {
  const pptx = new PptxGenJS();
  pptx.author = 'minimal-agent-ts';
  pptx.title = opts.title || 'Presentation';

  const slides =
    opts.slides.length > 0
      ? opts.slides
      : opts.title
        ? [{ title: opts.title, bullets: [] }]
        : [{ title: 'Slide 1', bullets: ['(empty)'] }];

  for (const s of slides) {
    const slide = pptx.addSlide();
    const title = s.title?.trim() || 'Untitled';
    slide.addText(title, {
      x: 0.5,
      y: 0.35,
      w: 9,
      h: 0.7,
      fontSize: 28,
      bold: true,
    });
    const bullets = s.bullets?.filter((b) => String(b).trim()) ?? [];
    if (bullets.length > 0) {
      slide.addText(
        bullets.map((b) => ({ text: String(b), options: { bullet: true, breakLine: true } })),
        { x: 0.6, y: 1.3, w: 8.8, h: 5, fontSize: 16, valign: 'top' },
      );
    } else if (s.body?.trim()) {
      slide.addText(s.body.trim(), {
        x: 0.6,
        y: 1.3,
        w: 8.8,
        h: 5,
        fontSize: 16,
        valign: 'top',
      });
    }
  }

  // pptxgenjs writeFile writes relative to cwd; use write + buffer for absolute path
  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  writeFileSync(absPath, out);
}

// ─── Tool handlers ──────────────────────────────────────────────────────────

function parseParagraphs(args: Record<string, unknown>): string[] {
  if (Array.isArray(args.paragraphs)) {
    return args.paragraphs.map((p) => String(p ?? '').trim()).filter(Boolean);
  }
  if (typeof args.text === 'string' && args.text.trim()) {
    return args.text
      .replace(/\r\n/g, '\n')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
  }
  return [];
}

function parseSlides(
  args: Record<string, unknown>,
): Array<{ title?: string; bullets?: string[]; body?: string }> {
  if (!Array.isArray(args.slides)) return [];
  return args.slides.map((raw) => {
    const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const bullets = Array.isArray(s.bullets)
      ? s.bullets.map((b) => String(b ?? ''))
      : undefined;
    return {
      title: typeof s.title === 'string' ? s.title : undefined,
      bullets,
      body: typeof s.body === 'string' ? s.body : undefined,
    };
  });
}

export async function runOfficeTool(
  toolName: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  if (toolName !== 'office_read' && toolName !== 'office_write') return null;

  try {
    if (toolName === 'office_read') {
      return await runOfficeRead(args, config);
    }
    return await runOfficeWrite(args, config);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return '[aborted]';
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `error: ${msg}`;
  }
}

async function runOfficeRead(
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string> {
  const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
  if (!rawPath) return 'error: path is required';

  const abs = await resolveReadablePath(config, rawPath, `office_read: ${rawPath}`);
  if (!existsSync(abs)) return `error: file not found: ${rawPath}`;

  const kind = detectOfficeKind(abs);
  if (!kind) {
    return 'error: unsupported type (use .docx, .pptx, or .xlsx)';
  }

  let fileSize = 0;
  try {
    fileSize = statSync(abs).size;
  } catch {
    return `error: cannot stat file: ${rawPath}`;
  }
  if (fileSize > MAX_OFFICE_FILE_BYTES) {
    return `error: file too large (${fileSize} bytes > ${MAX_OFFICE_FILE_BYTES}); refuse to parse`;
  }

  const maxChars = clampInt(args.max_chars, DEFAULT_MAX_CHARS, 1_000, MAX_MAX_CHARS);
  const format = args.format === 'json' ? 'json' : 'markdown';
  const buf = readFileSync(abs);

  let body: string;
  if (kind === 'docx') {
    const text = await readDocxBuffer(buf);
    if (format === 'json') {
      body = JSON.stringify({ kind: 'docx', path: rawPath, text }, null, 2);
    } else {
      body = `# Document: ${basename(abs)}\n\n${text}`;
    }
  } else if (kind === 'pptx') {
    const text = await readPptxBuffer(buf);
    if (format === 'json') {
      body = JSON.stringify({ kind: 'pptx', path: rawPath, markdown: text }, null, 2);
    } else {
      body = text;
    }
  } else {
    const maxRows = clampInt(args.max_rows, DEFAULT_XLSX_MAX_ROWS, 1, MAX_XLSX_MAX_ROWS);
    const sheet = typeof args.sheet === 'string' ? args.sheet : undefined;
    const result = await readXlsxFile(abs, { sheet, maxRows });
    body = format === 'json' ? JSON.stringify(result.json, null, 2) : result.markdown;
  }

  const { inline } = spillIfNeeded(config.cwd, abs, body, maxChars);
  return inline;
}

async function runOfficeWrite(
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string> {
  const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
  if (!rawPath) return 'error: path is required';

  const abs = resolveWritablePath(config.cwd, rawPath);
  const kind = detectOfficeKind(abs);
  if (!kind) {
    return 'error: unsupported type (use .docx, .pptx, or .xlsx extension)';
  }

  mkdirSync(resolve(abs, '..'), { recursive: true });

  if (kind === 'docx') {
    const paragraphs = parseParagraphs(args);
    if (paragraphs.length === 0) {
      return 'error: docx write requires paragraphs[] or text';
    }
    await writeDocxFile(abs, paragraphs);
    return `ok: wrote docx ${rawPath} (${paragraphs.length} paragraphs)`;
  }

  if (kind === 'pptx') {
    const slides = parseSlides(args);
    const title = typeof args.title === 'string' ? args.title : undefined;
    if (slides.length === 0 && !title) {
      return 'error: pptx write requires slides[] and/or title';
    }
    await writePptxFile(abs, { title, slides });
    const n = slides.length > 0 ? slides.length : 1;
    return `ok: wrote pptx ${rawPath} (${n} slides)`;
  }

  // xlsx light edit
  const sheet =
    (typeof args.sheet === 'string' && args.sheet.trim()) || 'Sheet1';
  const appendRows = Array.isArray(args.append_rows)
    ? (args.append_rows as unknown[][])
    : undefined;
  const setCells = Array.isArray(args.set_cells)
    ? (args.set_cells as Array<{ cell: string; value: unknown }>)
    : undefined;
  const headers = Array.isArray(args.headers)
    ? args.headers.map((h) => String(h ?? ''))
    : undefined;
  const replaceSheet = args.replace_sheet === true;

  if (!appendRows?.length && !setCells?.length && !headers?.length) {
    return 'error: xlsx write needs append_rows, set_cells, and/or headers (light edit only)';
  }

  return writeXlsxLight(abs, {
    sheet,
    appendRows,
    setCells,
    replaceSheet,
    headers,
  });
}
