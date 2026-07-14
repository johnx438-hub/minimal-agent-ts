/**
 * Office tools (Node-only): docx/pptx first-class layout; xlsx read + light edit.
 * No shell / no external CLI.
 *
 * Packages (write = generate; not in-place edit of arbitrary existing files):
 * - docx: paragraphs, headings, runs, markdown-inline, bullets/numbers, tables, images,
 *         pagebreak, header/footer; append_blocks via sidecar *.docx.office.json
 * - pptxgenjs: slide layouts, masters, charts, text/tables/shapes/images, notes, backgrounds
 * - mammoth: docx → structured markdown (headings/lists)
 * - exceljs / jszip: xlsx + pptx text extract
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';

import {
  AlignmentType,
  BorderStyle,
  convertInchesToTwip,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type IRunOptions,
  type ISectionOptions,
  type ITableCellOptions,
} from 'docx';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import TurndownService from 'turndown';

// pptxgenjs is CJS; ESM default interop is unreliable across Node loaders.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PptxGenJS = require('pptxgenjs') as new () => PptxPres;

type PptxCoord = number | string;
type PptxSlide = {
  background?: { color?: string; transparency?: number };
  color?: string;
  addText: (text: unknown, opts?: Record<string, unknown>) => void;
  addTable: (rows: unknown[], opts?: Record<string, unknown>) => void;
  addShape: (shape: string, opts?: Record<string, unknown>) => void;
  addImage: (opts: Record<string, unknown>) => void;
  addChart: (type: string, data: unknown[], opts?: Record<string, unknown>) => void;
  addNotes: (notes: string) => void;
};
type PptxPres = {
  author: string;
  title: string;
  subject: string;
  layout: string;
  ShapeType: Record<string, string>;
  ChartType: Record<string, string>;
  defineSlideMaster: (props: Record<string, unknown>) => void;
  addSlide: (props?: { masterName?: string }) => PptxSlide;
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
const MAX_BLOCKS = 400;
const MAX_SLIDES = 80;
const MAX_TABLE_CELLS = 2_000;
const MAX_OBJECTS_PER_SLIDE = 40;
const MAX_MASTERS = 12;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_CHART_POINTS = 500;
const DEFAULT_IMG_WIDTH_PX = 400;
const DEFAULT_IMG_HEIGHT_PX = 300;

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

/**
 * Light tool schemas exposed to the model every turn.
 * Handler still accepts full rich args (blocks detail, masters, charts, page, …);
 * recipes live in skill `office-layout` via invoke_skill.
 */
export const OFFICE_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'office_read',
      description:
        'Read Office file under cwd (docx/pptx/xlsx) → text summary. ' +
        'Optional: format markdown|json, max_chars, sheet/max_rows (xlsx). ' +
        'Write recipes: invoke_skill("office-layout"). Pure Node.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path under cwd.' },
          format: {
            type: 'string',
            enum: ['markdown', 'json'],
            description: 'Default markdown.',
          },
          max_chars: { type: 'number', description: `Inline cap (default ${DEFAULT_MAX_CHARS}).` },
          sheet: { type: 'string', description: 'xlsx sheet name.' },
          max_rows: { type: 'number', description: `xlsx row sample (default ${DEFAULT_XLSX_MAX_ROWS}).` },
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
        'Write Office under cwd (generate). Light: paragraphs/text; slides[{title,bullets,body}]; ' +
        'xlsx append_rows/set_cells. Rich (blocks, markdown, tables, append_blocks, images, ' +
        'pptx masters/charts/objects, page/header/footer): invoke_skill("office-layout") then pass ' +
        'those fields here — handler accepts full recipe keys even if not listed below. Pure Node.',
      parameters: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: {
            type: 'string',
            description: 'Output path; extension selects docx|pptx|xlsx.',
          },
          // docx light
          paragraphs: {
            type: 'array',
            items: { type: 'string' },
            description: 'docx plain paragraphs (markdown inline ok).',
          },
          text: {
            type: 'string',
            description: 'docx body; blank lines → paragraphs if paragraphs/blocks omitted.',
          },
          blocks: {
            type: 'array',
            items: { type: 'object' },
            description:
              'docx structured body (objects). Shapes in skill office-layout: heading/paragraph/bullet/number/table/image/pagebreak.',
          },
          append_blocks: {
            type: 'array',
            items: { type: 'object' },
            description:
              'docx append to draft; needs path.docx.office.json from prior structured write.',
          },
          // pptx light
          title: { type: 'string', description: 'pptx title / fallback slide.' },
          slides: {
            type: 'array',
            items: { type: 'object' },
            description:
              'pptx slides as objects. Light: title, bullets[], body. Rich: layout, master, objects, notes — see skill.',
          },
          // xlsx light
          sheet: { type: 'string', description: 'xlsx sheet (default Sheet1).' },
          headers: {
            type: 'array',
            items: { type: 'string' },
            description: 'xlsx header row when creating/replacing.',
          },
          append_rows: {
            type: 'array',
            items: { type: 'array' },
            description: 'xlsx rows to append.',
          },
          set_cells: {
            type: 'array',
            items: { type: 'object' },
            description: 'xlsx [{ cell, value }, …].',
          },
          replace_sheet: {
            type: 'boolean',
            description: 'xlsx clear sheet before append when true.',
          },
        },
        required: ['path'],
      },
    },
  },
];

/** Serialized size of tool defs exposed to the model (tests / diagnostics). */
export function officeDefinitionsJsonSize(defs: ToolDefinition[] = OFFICE_DEFINITIONS): number {
  return JSON.stringify(defs).length;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampNum(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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

function normalizeHexColor(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let s = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    s = s
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return undefined;
  return s.toUpperCase();
}

type RasterImageType = 'jpg' | 'png' | 'gif' | 'bmp';

function detectRasterImageType(path: string): RasterImageType | null {
  const ext = extname(path).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
  if (ext === '.gif') return 'gif';
  if (ext === '.bmp') return 'bmp';
  return null;
}

function resolveImageUnderCwd(cwd: string, relPath: string): { abs: string; data: Buffer; type: RasterImageType } {
  const abs = resolveWritablePath(cwd, relPath);
  if (!existsSync(abs)) {
    throw new Error(`image not found: ${relPath}`);
  }
  const st = statSync(abs);
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${st.size} bytes > ${MAX_IMAGE_BYTES}): ${relPath}`);
  }
  const type = detectRasterImageType(abs);
  if (!type) {
    throw new Error(`unsupported image type (use .png/.jpg/.gif/.bmp): ${relPath}`);
  }
  return { abs, data: readFileSync(abs), type };
}

/** Resolve display size in pixels for docx ImageRun (96 dpi for inch inputs). */
function resolveImagePixels(block: Record<string, unknown>): { width: number; height: number } {
  let width = DEFAULT_IMG_WIDTH_PX;
  let height = DEFAULT_IMG_HEIGHT_PX;
  if (typeof block.width_px === 'number' && Number.isFinite(block.width_px)) {
    width = clampNum(block.width_px, DEFAULT_IMG_WIDTH_PX, 16, 4000);
  } else if (typeof block.width_in === 'number' && Number.isFinite(block.width_in)) {
    width = Math.round(clampNum(block.width_in, 4, 0.2, 10) * 96);
  }
  if (typeof block.height_px === 'number' && Number.isFinite(block.height_px)) {
    height = clampNum(block.height_px, DEFAULT_IMG_HEIGHT_PX, 16, 4000);
  } else if (typeof block.height_in === 'number' && Number.isFinite(block.height_in)) {
    height = Math.round(clampNum(block.height_in, 3, 0.2, 10) * 96);
  } else if (
    typeof block.width_in === 'number' &&
    Number.isFinite(block.width_in) &&
    block.height_px === undefined &&
    block.height_in === undefined
  ) {
    // keep default aspect-ish when only width given
    height = Math.round(width * 0.75);
  }
  return { width: Math.round(width), height: Math.round(height) };
}

// ─── DOCX ───────────────────────────────────────────────────────────────────

const HEADING_MAP = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

function mapAlign(
  align: unknown,
): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  if (typeof align !== 'string') return undefined;
  switch (align.toLowerCase()) {
    case 'left':
    case 'start':
      return AlignmentType.LEFT;
    case 'center':
      return AlignmentType.CENTER;
    case 'right':
    case 'end':
      return AlignmentType.RIGHT;
    case 'justify':
    case 'both':
      return AlignmentType.JUSTIFIED;
    default:
      return undefined;
  }
}

type DocxRunInput = {
  text?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  size_pt?: number;
  font?: string;
  highlight?: string;
  strike?: boolean;
};

function buildTextRun(run: DocxRunInput | string): TextRun {
  if (typeof run === 'string') return new TextRun(run);
  const text = String(run.text ?? '');
  let highlight: IRunOptions['highlight'] | undefined;
  if (typeof run.highlight === 'string' && run.highlight.trim()) {
    const h = run.highlight.trim().toLowerCase();
    const allowed = new Set([
      'yellow',
      'green',
      'cyan',
      'magenta',
      'blue',
      'red',
      'darkBlue',
      'darkCyan',
      'darkGreen',
      'darkMagenta',
      'darkRed',
      'darkYellow',
      'darkGray',
      'lightGray',
      'black',
    ]);
    const map: Record<string, string> = {
      grey: 'lightGray',
      gray: 'lightGray',
      darkgrey: 'darkGray',
      darkgray: 'darkGray',
    };
    const key = map[h] ?? h;
    if (allowed.has(key)) highlight = key as IRunOptions['highlight'];
  }
  const color = normalizeHexColor(run.color);
  const opts: IRunOptions = {
    text,
    ...(run.bold === true ? { bold: true } : {}),
    ...(run.italic === true ? { italics: true } : {}),
    ...(run.underline === true ? { underline: {} } : {}),
    ...(run.strike === true ? { strike: true } : {}),
    ...(color ? { color } : {}),
    ...(typeof run.size_pt === 'number' && Number.isFinite(run.size_pt)
      ? { size: Math.round(clampNum(run.size_pt, 11, 6, 72) * 2) }
      : {}),
    ...(typeof run.font === 'string' && run.font.trim() ? { font: run.font.trim() } : {}),
    ...(highlight ? { highlight } : {}),
  };
  return new TextRun(opts);
}

/** Detect common markdown-like inline markers (for skip-fast path). */
export function hasMarkdownInlineMarkers(text: string): boolean {
  return /[*_`~]/.test(text);
}

/**
 * Expand markdown-like inline markup into run descriptors.
 * Supports: **bold**, __bold__, *italic*, _italic_, ~~strike~~, `code`, backslash escapes.
 * Toggle markers; unclosed markers leave remaining text plain with style still on (best-effort).
 */
export function parseMarkdownInline(text: string): DocxRunInput[] {
  const runs: DocxRunInput[] = [];
  let i = 0;
  let bold = false;
  let italic = false;
  let strike = false;
  let code = false;
  let buf = '';

  const push = (): void => {
    if (buf.length === 0) return;
    const run: DocxRunInput = { text: buf };
    if (bold) run.bold = true;
    if (italic) run.italic = true;
    if (strike) run.strike = true;
    if (code) {
      run.font = 'Consolas';
      run.size_pt = 10;
    }
    runs.push(run);
    buf = '';
  };

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '\\' && i + 1 < text.length) {
      buf += text[i + 1]!;
      i += 2;
      continue;
    }

    if (!code && text.startsWith('**', i)) {
      push();
      bold = !bold;
      i += 2;
      continue;
    }
    if (!code && text.startsWith('__', i)) {
      push();
      bold = !bold;
      i += 2;
      continue;
    }
    if (!code && text.startsWith('~~', i)) {
      push();
      strike = !strike;
      i += 2;
      continue;
    }
    if (ch === '`') {
      push();
      code = !code;
      i += 1;
      continue;
    }
    if (!code && ch === '*' && !text.startsWith('**', i)) {
      push();
      italic = !italic;
      i += 1;
      continue;
    }
    if (!code && ch === '_' && !text.startsWith('__', i)) {
      push();
      italic = !italic;
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }
  push();
  return runs.length > 0 ? runs : [{ text: '' }];
}

function blockMarkdownEnabled(block: Record<string, unknown>): boolean {
  return block.markdown !== false;
}

/** text → TextRun[]; uses markdown unless disabled or empty. */
function textToTextRuns(
  text: string,
  opts?: { markdown?: boolean; base?: DocxRunInput },
): TextRun[] {
  const useMd = opts?.markdown !== false;
  const base = opts?.base ?? {};
  if (!useMd || !hasMarkdownInlineMarkers(text)) {
    return [buildTextRun({ ...base, text })];
  }
  return parseMarkdownInline(text).map((r) =>
    buildTextRun({
      ...base,
      ...r,
      bold: r.bold === true || base.bold === true,
      italic: r.italic === true || base.italic === true,
      strike: r.strike === true || base.strike === true,
      font: r.font ?? base.font,
      size_pt: r.size_pt ?? base.size_pt,
    }),
  );
}

/**
 * Normalize table rows:
 * - string[] → each string is one row (single cell, or "A | B | C" columns)
 * - (string|string[])[][] → cells; string[] cell = multi-paragraph
 * - cell string with \\n → multi-paragraph
 */
export function normalizeTableMatrix(block: Record<string, unknown>): string[][] {
  const headers = Array.isArray(block.headers)
    ? block.headers.map((h) => String(h ?? ''))
    : [];
  const rowsRaw = Array.isArray(block.rows) ? block.rows : [];

  const splitRowString = (s: string): string[] => {
    // Column shorthand only when " | " present (avoid splitting free text with |)
    if (s.includes(' | ')) {
      return s.split(/\s*\|\s*/).map((c) => c.trim());
    }
    return [s];
  };

  const bodyRows: string[][] = [];
  // string[] shorthand (one row per string) vs string[][] matrix
  const allAreScalars = rowsRaw.length > 0 && rowsRaw.every((r) => !Array.isArray(r));

  if (allAreScalars) {
    for (const r of rowsRaw) {
      bodyRows.push(splitRowString(String(r ?? '')));
    }
  } else {
    for (const r of rowsRaw) {
      if (Array.isArray(r)) {
        bodyRows.push(r.map((c) => (Array.isArray(c) ? c.map(String).join('\n') : String(c ?? ''))));
      } else {
        bodyRows.push(splitRowString(String(r ?? '')));
      }
    }
  }

  return headers.length > 0 ? [headers, ...bodyRows] : bodyRows;
}

/** Split a cell value into paragraph strings. */
function cellToParagraphs(cell: string): string[] {
  const parts = cell.replace(/\r\n/g, '\n').split('\n');
  return parts.length > 0 ? parts : [''];
}

function spacingOpts(block: Record<string, unknown>): IParagraphOptions['spacing'] {
  const after = block.spacing_after_pt;
  const before = block.spacing_before_pt;
  if (typeof after !== 'number' && typeof before !== 'number') return undefined;
  return {
    ...(typeof before === 'number' && Number.isFinite(before)
      ? { before: Math.round(clampNum(before, 0, 0, 72) * 20) }
      : {}),
    ...(typeof after === 'number' && Number.isFinite(after)
      ? { after: Math.round(clampNum(after, 0, 0, 72) * 20) }
      : {}),
  };
}

function buildNumberingConfig() {
  const bulletLevels = Array.from({ length: 5 }, (_, level) => ({
    level,
    format: LevelFormat.BULLET,
    text: '•',
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: {
        indent: {
          left: convertInchesToTwip(0.5 + level * 0.25),
          hanging: convertInchesToTwip(0.25),
        },
      },
    },
  }));
  const numberLevels = Array.from({ length: 5 }, (_, level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: {
        indent: {
          left: convertInchesToTwip(0.5 + level * 0.25),
          hanging: convertInchesToTwip(0.25),
        },
      },
    },
  }));
  return {
    config: [
      { reference: 'office-bullets', levels: bulletLevels },
      { reference: 'office-numbers', levels: numberLevels },
    ],
  };
}

function buildTableFromBlock(block: Record<string, unknown>): Table | null {
  const allRows = normalizeTableMatrix(block);
  if (allRows.length === 0) return null;

  const hasHeaderRow = Array.isArray(block.headers) && block.headers.length > 0;
  const md = blockMarkdownEnabled(block);
  const colCount = Math.max(...allRows.map((r) => r.length), 1);
  let cellCount = 0;
  for (const r of allRows) cellCount += r.length;
  if (cellCount > MAX_TABLE_CELLS) {
    throw new Error(`docx table too large (${cellCount} cells > ${MAX_TABLE_CELLS})`);
  }

  // ~6.5" content width default
  const totalWidth = convertInchesToTwip(6.5);
  const colW = Math.floor(totalWidth / colCount);

  const makeCell = (text: string, header: boolean): TableCell => {
    const paras = cellToParagraphs(text);
    const children = paras.map(
      (p) =>
        new Paragraph({
          children: textToTextRuns(p, {
            markdown: md,
            base: {
              bold: header || undefined,
              size_pt: header ? 11 : 10,
            },
          }),
        }),
    );
    const opts: ITableCellOptions = {
      width: { size: colW, type: WidthType.DXA },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
        left: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
        right: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      },
      children: children.length > 0 ? children : [new Paragraph({ children: [new TextRun('')] })],
      ...(header ? { shading: { type: ShadingType.CLEAR, fill: 'F0F0F0' } } : {}),
    };
    return new TableCell(opts);
  };

  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: Array.from({ length: colCount }, () => colW),
    rows: allRows.map(
      (row, ri) =>
        new TableRow({
          children: Array.from({ length: colCount }, (_, ci) =>
            makeCell(row[ci] ?? '', hasHeaderRow && ri === 0),
          ),
        }),
    ),
  });
}

function blocksToChildren(blocks: unknown[], cwd: string): Array<Paragraph | Table> {
  if (blocks.length > MAX_BLOCKS) {
    throw new Error(`docx blocks too many (${blocks.length} > ${MAX_BLOCKS})`);
  }
  const children: Array<Paragraph | Table> = [];

  for (const raw of blocks) {
    const b =
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : { type: 'paragraph', text: String(raw ?? '') };
    const type = String(b.type ?? 'paragraph').toLowerCase();
    const align = mapAlign(b.align);
    const spacing = spacingOpts(b);

    if (type === 'pagebreak') {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      continue;
    }

    const md = blockMarkdownEnabled(b);

    if (type === 'heading') {
      const level = clampInt(b.level, 1, 1, 6);
      const text = String(b.text ?? '').trim() || 'Untitled';
      children.push(
        new Paragraph({
          heading: HEADING_MAP[level - 1],
          alignment: align,
          spacing,
          children: textToTextRuns(text, { markdown: md, base: { bold: true } }),
        }),
      );
      continue;
    }

    if (type === 'bullet' || type === 'number') {
      const items = Array.isArray(b.items)
        ? b.items.map((i) => String(i ?? '').trim()).filter(Boolean)
        : String(b.text ?? '')
            .split(/\n/)
            .map((s) => s.trim())
            .filter(Boolean);
      const level = clampInt(b.level, 0, 0, 4);
      const reference = type === 'bullet' ? 'office-bullets' : 'office-numbers';
      for (const item of items) {
        children.push(
          new Paragraph({
            numbering: { reference, level },
            spacing,
            children: textToTextRuns(item, { markdown: md }),
          }),
        );
      }
      continue;
    }

    if (type === 'table') {
      const table = buildTableFromBlock(b);
      if (table) children.push(table);
      // spacer after table
      children.push(new Paragraph({ children: [] }));
      continue;
    }

    if (type === 'image') {
      const imgPath = typeof b.path === 'string' ? b.path.trim() : '';
      if (!imgPath) {
        throw new Error('docx image block requires path');
      }
      const { data, type: imgType } = resolveImageUnderCwd(cwd, imgPath);
      const { width, height } = resolveImagePixels(b);
      const alt =
        (typeof b.alt === 'string' && b.alt.trim()) ||
        (typeof b.text === 'string' && b.text.trim()) ||
        basename(imgPath);
      children.push(
        new Paragraph({
          alignment: align ?? AlignmentType.CENTER,
          spacing,
          children: [
            new ImageRun({
              type: imgType,
              data,
              transformation: { width, height },
              altText: {
                title: alt,
                description: alt,
                name: basename(imgPath),
              },
            }),
          ],
        }),
      );
      continue;
    }

    // paragraph (default)
    const runs = Array.isArray(b.runs)
      ? (b.runs as Array<DocxRunInput | string>).map(buildTextRun)
      : textToTextRuns(String(b.text ?? ''), { markdown: md });
    const para: IParagraphOptions = {
      children: runs,
      alignment: align,
      spacing,
    };
    children.push(new Paragraph(para));
  }

  return children.length > 0 ? children : [new Paragraph({ children: [new TextRun('(empty)')] })];
}

// ─── DOCX sidecar (append_blocks) ───────────────────────────────────────────

const DOCX_SIDECAR_VERSION = 1 as const;

export type DocxSidecar = {
  v: typeof DOCX_SIDECAR_VERSION;
  kind: 'docx';
  blocks: unknown[];
  doc_title?: string;
  header?: string;
  footer?: unknown;
  page?: unknown;
  updated_at: string;
};

export function docxSidecarPath(absDocx: string): string {
  return `${absDocx}.office.json`;
}

export function loadDocxSidecar(absDocx: string): DocxSidecar | null {
  const p = docxSidecarPath(absDocx);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as DocxSidecar;
    if (!raw || raw.kind !== 'docx' || !Array.isArray(raw.blocks)) return null;
    return raw;
  } catch {
    return null;
  }
}

function saveDocxSidecar(absDocx: string, draft: DocxSidecar): void {
  const out: DocxSidecar = {
    ...draft,
    v: DOCX_SIDECAR_VERSION,
    kind: 'docx',
    updated_at: new Date().toISOString(),
  };
  writeFileSync(docxSidecarPath(absDocx), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

function parseFooterArg(
  footer: unknown,
): { text?: string; pageNumbers: boolean } | undefined {
  if (footer === undefined || footer === null || footer === false) return undefined;
  if (footer === true) return { pageNumbers: true };
  if (typeof footer === 'string') {
    return { text: footer, pageNumbers: false };
  }
  if (typeof footer === 'object') {
    const o = footer as Record<string, unknown>;
    return {
      text: typeof o.text === 'string' ? o.text : undefined,
      pageNumbers: o.page_numbers === true || o.pageNumbers === true,
    };
  }
  return undefined;
}

export async function readDocxBuffer(buf: Buffer): Promise<string> {
  try {
    const htmlResult = await mammoth.convertToHtml({ buffer: buf });
    const html = (htmlResult.value ?? '').trim();
    if (html) {
      const td = new TurndownService({
        headingStyle: 'atx',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
      });
      const md = td.turndown(html).trim();
      if (md) return md;
    }
  } catch {
    // fall through to raw text
  }
  const result = await mammoth.extractRawText({ buffer: buf });
  const text = (result.value ?? '').replace(/\r\n/g, '\n').trim();
  return text || '(empty document)';
}

function resolveDocxBlocksAndMeta(
  absPath: string,
  args: Record<string, unknown>,
): {
  blocks: unknown[];
  mode: string;
  doc_title?: string;
  header?: string;
  footer?: unknown;
  page?: unknown;
} {
  const appendBlocks = Array.isArray(args.append_blocks) ? args.append_blocks : null;
  const fullBlocks = Array.isArray(args.blocks) ? args.blocks : null;
  const hasSimple =
    (Array.isArray(args.paragraphs) && args.paragraphs.length > 0) ||
    (typeof args.text === 'string' && args.text.trim().length > 0);

  if (appendBlocks && appendBlocks.length > 0) {
    if (fullBlocks && fullBlocks.length > 0) {
      throw new Error('docx: pass either blocks (replace) or append_blocks (append), not both');
    }
    const prev = loadDocxSidecar(absPath);
    if (!prev) {
      throw new Error(
        'docx append_blocks requires a prior structured write (missing sidecar ' +
          `${basename(absPath)}.office.json). First office_write with blocks[] or paragraphs/text.`,
      );
    }
    const merged = [...prev.blocks, ...appendBlocks];
    if (merged.length > MAX_BLOCKS) {
      throw new Error(`docx blocks too many after append (${merged.length} > ${MAX_BLOCKS})`);
    }
    return {
      blocks: merged,
      mode: 'append',
      doc_title:
        typeof args.doc_title === 'string'
          ? args.doc_title
          : prev.doc_title,
      header:
        typeof args.header === 'string'
          ? args.header
          : prev.header,
      footer: args.footer !== undefined ? args.footer : prev.footer,
      page: args.page !== undefined ? args.page : prev.page,
    };
  }

  if (fullBlocks && fullBlocks.length > 0) {
    return {
      blocks: fullBlocks,
      mode: 'blocks',
      doc_title: typeof args.doc_title === 'string' ? args.doc_title : typeof args.title === 'string' ? args.title : undefined,
      header: typeof args.header === 'string' ? args.header : undefined,
      footer: args.footer,
      page: args.page,
    };
  }

  if (hasSimple) {
    const paragraphs = parseParagraphs(args);
    return {
      blocks: paragraphs.map((p) => ({ type: 'paragraph', text: p })),
      mode: 'paragraphs',
      doc_title: typeof args.doc_title === 'string' ? args.doc_title : typeof args.title === 'string' ? args.title : undefined,
      header: typeof args.header === 'string' ? args.header : undefined,
      footer: args.footer,
      page: args.page,
    };
  }

  throw new Error(
    'docx write requires blocks[], append_blocks[], paragraphs[], or text',
  );
}

async function writeDocxFile(
  absPath: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<{ blocks: number; mode: string; appended?: number }> {
  const resolved = resolveDocxBlocksAndMeta(absPath, args);
  const appendCount =
    resolved.mode === 'append' && Array.isArray(args.append_blocks)
      ? args.append_blocks.length
      : undefined;

  const children = blocksToChildren(resolved.blocks, cwd);

  const page =
    resolved.page && typeof resolved.page === 'object'
      ? (resolved.page as Record<string, unknown>)
      : {};
  const orientation =
    page.orientation === 'landscape' ? ('landscape' as const) : ('portrait' as const);
  const marginsIn =
    page.margins_in && typeof page.margins_in === 'object'
      ? (page.margins_in as Record<string, unknown>)
      : {};
  const m = (k: string, d: number) =>
    convertInchesToTwip(clampNum(marginsIn[k], d, 0.25, 3));

  const headerText =
    typeof resolved.header === 'string' && resolved.header.trim()
      ? resolved.header.trim()
      : undefined;
  const footerSpec = parseFooterArg(resolved.footer);

  let footerChildren: TextRun[] | undefined;
  if (footerSpec) {
    const parts: TextRun[] = [];
    if (footerSpec.text?.trim()) {
      parts.push(new TextRun({ text: footerSpec.text.trim(), size: 18, color: '666666' }));
      if (footerSpec.pageNumbers) {
        parts.push(new TextRun({ text: '  ·  ', size: 18, color: '666666' }));
      }
    }
    if (footerSpec.pageNumbers) {
      parts.push(new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '666666' }));
      parts.push(new TextRun({ text: ' / ', size: 18, color: '666666' }));
      parts.push(new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: '666666' }));
    }
    if (parts.length > 0) footerChildren = parts;
  }

  const section: ISectionOptions = {
    properties: {
      page: {
        size: { orientation },
        margin: {
          top: m('top', 1),
          right: m('right', 1),
          bottom: m('bottom', 1),
          left: m('left', 1),
        },
      },
    },
    children,
    ...(headerText
      ? {
          headers: {
            default: new Header({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: headerText,
                      italics: true,
                      size: 18,
                      color: '666666',
                    }),
                  ],
                }),
              ],
            }),
          },
        }
      : {}),
    ...(footerChildren
      ? {
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: footerChildren,
                }),
              ],
            }),
          },
        }
      : {}),
  };

  const docTitle = resolved.doc_title;

  const doc = new Document({
    title: docTitle,
    creator: 'minimal-agent-ts',
    numbering: buildNumberingConfig(),
    sections: [section],
  });
  const buffer = await Packer.toBuffer(doc);
  writeFileSync(absPath, buffer);

  // Sidecar enables append_blocks without re-parsing OOXML
  saveDocxSidecar(absPath, {
    v: DOCX_SIDECAR_VERSION,
    kind: 'docx',
    blocks: resolved.blocks,
    doc_title: docTitle,
    header: headerText,
    footer: resolved.footer,
    page: resolved.page,
    updated_at: new Date().toISOString(),
  });

  return {
    blocks: resolved.blocks.length,
    mode: resolved.mode,
    ...(appendCount !== undefined ? { appended: appendCount } : {}),
  };
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

type SlidePane = { title?: string; bullets?: string[]; body?: string };
type SlideInput = {
  title?: string;
  subtitle?: string;
  bullets?: string[];
  body?: string;
  notes?: string;
  background?: string;
  layout?: string;
  master?: string;
  left?: SlidePane;
  right?: SlidePane;
  objects?: unknown[];
};

type MasterInput = {
  name: string;
  background?: string;
  slideNumber?: Record<string, unknown>;
  objects?: unknown[];
};

function parseSlidePane(raw: unknown): SlidePane | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  return {
    title: typeof s.title === 'string' ? s.title : undefined,
    bullets: Array.isArray(s.bullets) ? s.bullets.map((b) => String(b ?? '')) : undefined,
    body: typeof s.body === 'string' ? s.body : undefined,
  };
}

function parseSlides(args: Record<string, unknown>): SlideInput[] {
  if (!Array.isArray(args.slides)) return [];
  return args.slides.map((raw) => {
    const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const bullets = Array.isArray(s.bullets)
      ? s.bullets.map((b) => String(b ?? ''))
      : undefined;
    return {
      title: typeof s.title === 'string' ? s.title : undefined,
      subtitle: typeof s.subtitle === 'string' ? s.subtitle : undefined,
      bullets,
      body: typeof s.body === 'string' ? s.body : undefined,
      notes: typeof s.notes === 'string' ? s.notes : undefined,
      background: typeof s.background === 'string' ? s.background : undefined,
      layout: typeof s.layout === 'string' ? s.layout : undefined,
      master:
        typeof s.master === 'string'
          ? s.master
          : typeof s.masterName === 'string'
            ? s.masterName
            : undefined,
      left: parseSlidePane(s.left),
      right: parseSlidePane(s.right),
      objects: Array.isArray(s.objects) ? s.objects : undefined,
    };
  });
}

function parseMasters(args: Record<string, unknown>): MasterInput[] {
  if (!Array.isArray(args.masters)) return [];
  if (args.masters.length > MAX_MASTERS) {
    throw new Error(`pptx masters too many (${args.masters.length} > ${MAX_MASTERS})`);
  }
  const out: MasterInput[] = [];
  for (const raw of args.masters) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    const name =
      (typeof m.name === 'string' && m.name.trim()) ||
      (typeof m.title === 'string' && m.title.trim()) ||
      '';
    if (!name) {
      throw new Error('pptx master requires name (or title)');
    }
    const sn = m.slide_number ?? m.slideNumber;
    out.push({
      name,
      background: typeof m.background === 'string' ? m.background : undefined,
      slideNumber:
        sn && typeof sn === 'object' ? (sn as Record<string, unknown>) : undefined,
      objects: Array.isArray(m.objects) ? m.objects : undefined,
    });
  }
  return out;
}

/** Map agent-friendly master chrome objects → pptxgenjs defineSlideMaster objects[]. */
function buildMasterObjects(
  objects: unknown[] | undefined,
  cwd: string,
): Array<Record<string, unknown>> {
  if (!objects?.length) return [];
  if (objects.length > MAX_OBJECTS_PER_SLIDE) {
    throw new Error(
      `pptx master objects too many (${objects.length} > ${MAX_OBJECTS_PER_SLIDE})`,
    );
  }
  const result: Array<Record<string, unknown>> = [];
  for (const raw of objects) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const kind = String(o.kind ?? o.type ?? 'text').toLowerCase();
    const x = parseCoord(o.x, 0);
    const y = parseCoord(o.y, 0);
    const w = parseCoord(o.w, 1);
    const h = parseCoord(o.h, 0.3);

    if (kind === 'text') {
      const options: Record<string, unknown> = {
        x,
        y,
        w,
        h,
        fontSize: clampNum(o.fontSize ?? o.size_pt, 12, 6, 48),
        color: normalizeHexColor(o.color) ?? '333333',
        valign: typeof o.valign === 'string' ? o.valign : 'middle',
        align: typeof o.align === 'string' ? o.align : 'left',
      };
      if (o.bold === true) options.bold = true;
      if (typeof o.font === 'string') options.fontFace = o.font;
      result.push({ text: { text: String(o.text ?? ''), options } });
      continue;
    }

    if (kind === 'rect' || kind === 'rectangle' || kind === 'shape') {
      const shapeKind = String(o.shape ?? 'rect').toLowerCase();
      // masters only support rect/line in the simple object map (not full ShapeType)
      if (shapeKind === 'line') {
        const lineColor = normalizeHexColor(o.line ?? o.line_color ?? o.color) ?? 'CCCCCC';
        result.push({
          line: {
            x,
            y,
            w,
            h: typeof o.h === 'number' ? o.h : 0,
            line: { color: lineColor, width: clampNum(o.line_width, 1.5, 0.5, 12) },
          },
        });
        continue;
      }
      const fill = normalizeHexColor(o.fill ?? o.color) ?? 'F1F1F1';
      result.push({
        rect: {
          x,
          y,
          w,
          h,
          fill: { color: fill },
        },
      });
      continue;
    }

    if (kind === 'line') {
      const lineColor = normalizeHexColor(o.line ?? o.line_color ?? o.color) ?? 'CCCCCC';
      result.push({
        line: {
          x,
          y,
          w,
          h: typeof o.h === 'number' ? o.h : 0,
          line: { color: lineColor, width: clampNum(o.line_width, 1.5, 0.5, 12) },
        },
      });
      continue;
    }

    if (kind === 'image') {
      const imgPath = typeof o.path === 'string' ? o.path.trim() : '';
      if (!imgPath) continue;
      const { abs } = resolveImageUnderCwd(cwd, imgPath);
      const img: Record<string, unknown> = { path: abs, x, y };
      if (o.w !== undefined) img.w = w;
      if (o.h !== undefined) img.h = h;
      result.push({ image: img });
      continue;
    }
  }
  return result;
}

function applySlideMasters(pptx: PptxPres, masters: MasterInput[], cwd: string): void {
  for (const m of masters) {
    const props: Record<string, unknown> = { title: m.name };
    const bg = normalizeHexColor(m.background);
    if (bg) props.background = { color: bg };
    const masterObjs = buildMasterObjects(m.objects, cwd);
    if (masterObjs.length) props.objects = masterObjs;
    if (m.slideNumber) {
      const sn: Record<string, unknown> = {
        x: parseCoord(m.slideNumber.x, 9.0),
        y: parseCoord(m.slideNumber.y, 5.15),
        color: normalizeHexColor(m.slideNumber.color) ?? '666666',
        fontSize: clampNum(m.slideNumber.fontSize ?? m.slideNumber.font_size, 10, 8, 18),
      };
      props.slideNumber = sn;
    }
    pptx.defineSlideMaster(props);
  }
}

function mapChartType(pptx: PptxPres, raw: unknown): string {
  const name = String(raw ?? 'bar')
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, '');
  const aliases: Record<string, string> = {
    bar: 'bar',
    column: 'bar',
    col: 'bar',
    bar3d: 'bar3d',
    column3d: 'bar3d',
    line: 'line',
    area: 'area',
    pie: 'pie',
    doughnut: 'doughnut',
    donut: 'doughnut',
    radar: 'radar',
    scatter: 'scatter',
    bubble: 'bubble',
    bubble3d: 'bubble3d',
  };
  const key = aliases[name] ?? name;
  // ChartType keys: area, bar, bar3d, ...
  if (pptx.ChartType[key]) return pptx.ChartType[key]!;
  // try exact values
  const found = Object.entries(pptx.ChartType).find(
    ([k, v]) => k.toLowerCase() === key || String(v).toLowerCase() === key,
  );
  if (found) return found[1]!;
  return pptx.ChartType.bar ?? 'bar';
}

function buildChartSeries(obj: Record<string, unknown>): Array<{
  name: string;
  labels: string[];
  values: number[];
}> {
  if (Array.isArray(obj.series) && obj.series.length > 0) {
    const series = obj.series.map((raw, i) => {
      const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const labels = Array.isArray(s.labels)
        ? s.labels.map((l) => String(l ?? ''))
        : Array.isArray(obj.labels)
          ? (obj.labels as unknown[]).map((l) => String(l ?? ''))
          : [];
      const values = Array.isArray(s.values)
        ? s.values.map((v) => Number(v) || 0)
        : [];
      return {
        name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : `Series ${i + 1}`,
        labels,
        values,
      };
    });
    let points = 0;
    for (const s of series) points += s.values.length;
    if (points > MAX_CHART_POINTS) {
      throw new Error(`pptx chart too many points (${points} > ${MAX_CHART_POINTS})`);
    }
    return series;
  }

  // Simple single-series: labels + values
  const labels = Array.isArray(obj.labels)
    ? obj.labels.map((l) => String(l ?? ''))
    : [];
  const values = Array.isArray(obj.values)
    ? obj.values.map((v) => Number(v) || 0)
    : [];
  if (labels.length === 0 && values.length === 0) {
    throw new Error('pptx chart requires series[] or labels+values');
  }
  if (values.length > MAX_CHART_POINTS) {
    throw new Error(`pptx chart too many points (${values.length} > ${MAX_CHART_POINTS})`);
  }
  return [
    {
      name:
        (typeof obj.series_name === 'string' && obj.series_name) ||
        (typeof obj.name === 'string' && obj.name) ||
        'Series 1',
      labels: labels.length > 0 ? labels : values.map((_, i) => String(i + 1)),
      values,
    },
  ];
}

function resolveSlideLayout(s: SlideInput): string {
  if (s.layout?.trim()) return s.layout.trim().toLowerCase();
  if (s.objects?.length && !s.title && !s.bullets?.length && !s.body) return 'blank';
  if (s.left || s.right) return 'two_column';
  if (s.bullets?.some((b) => b.trim())) return 'title_bullets';
  if (s.body?.trim()) return 'title_body';
  if (s.subtitle?.trim()) return 'title';
  return 'title';
}

function pptxTextOpts(
  base: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, ...extra };
}

function addTitleText(slide: PptxSlide, title: string, opts?: Record<string, unknown>): void {
  slide.addText(title, pptxTextOpts({
    x: 0.5,
    y: 0.35,
    w: 9,
    h: 0.8,
    fontSize: 28,
    bold: true,
    color: '1A1A1A',
    valign: 'middle',
  }, opts));
}

function addBulletsText(
  slide: PptxSlide,
  bullets: string[],
  box: { x: PptxCoord; y: PptxCoord; w: PptxCoord; h: PptxCoord },
  fontSize = 16,
): void {
  const items = bullets.filter((b) => String(b).trim());
  if (items.length === 0) return;
  slide.addText(
    items.map((b) => ({
      text: String(b),
      options: { bullet: true, breakLine: true },
    })),
    {
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      fontSize,
      color: '333333',
      valign: 'top',
      paraSpaceAfter: 6,
    },
  );
}

function applyPresetLayout(slide: PptxSlide, s: SlideInput, layout: string): void {
  const title = s.title?.trim() || '';

  if (layout === 'blank') return;

  if (layout === 'section') {
    slide.addText(title || 'Section', {
      x: 0.5,
      y: 2.2,
      w: 9,
      h: 1.2,
      fontSize: 36,
      bold: true,
      color: 'FFFFFF',
      align: 'center',
      valign: 'middle',
    });
    if (s.subtitle?.trim()) {
      slide.addText(s.subtitle.trim(), {
        x: 1,
        y: 3.5,
        w: 8,
        h: 0.6,
        fontSize: 18,
        color: 'E0E0E0',
        align: 'center',
      });
    }
    return;
  }

  if (layout === 'title') {
    slide.addText(title || 'Untitled', {
      x: 0.5,
      y: 2.0,
      w: 9,
      h: 1.0,
      fontSize: 36,
      bold: true,
      color: '1A1A1A',
      align: 'center',
      valign: 'middle',
    });
    if (s.subtitle?.trim() || s.body?.trim()) {
      slide.addText((s.subtitle || s.body || '').trim(), {
        x: 1,
        y: 3.2,
        w: 8,
        h: 1.0,
        fontSize: 18,
        color: '555555',
        align: 'center',
      });
    }
    return;
  }

  if (layout === 'two_column') {
    if (title) addTitleText(slide, title);
    const y0 = title ? 1.3 : 0.5;
    const panes: Array<{ pane?: SlidePane; x: number }> = [
      { pane: s.left, x: 0.4 },
      { pane: s.right, x: 5.2 },
    ];
    for (const { pane, x } of panes) {
      if (!pane) continue;
      let y = y0;
      if (pane.title?.trim()) {
        slide.addText(pane.title.trim(), {
          x,
          y,
          w: 4.4,
          h: 0.45,
          fontSize: 18,
          bold: true,
          color: '1A1A1A',
        });
        y += 0.5;
      }
      if (pane.bullets?.length) {
        addBulletsText(slide, pane.bullets, { x, y, w: 4.4, h: 4.2 }, 14);
      } else if (pane.body?.trim()) {
        slide.addText(pane.body.trim(), {
          x,
          y,
          w: 4.4,
          h: 4.2,
          fontSize: 14,
          color: '333333',
          valign: 'top',
        });
      }
    }
    return;
  }

  // title_bullets / title_body / default
  if (title) addTitleText(slide, title);
  const yBody = title ? 1.3 : 0.5;
  if (layout === 'title_body' || (s.body?.trim() && !s.bullets?.some((b) => b.trim()))) {
    if (s.body?.trim()) {
      slide.addText(s.body.trim(), {
        x: 0.6,
        y: yBody,
        w: 8.8,
        h: 4.0,
        fontSize: 16,
        color: '333333',
        valign: 'top',
      });
    }
  } else {
    addBulletsText(slide, s.bullets ?? [], { x: 0.6, y: yBody, w: 8.8, h: 4.0 });
  }
}

function mapShapeName(pptx: PptxPres, name: unknown): string {
  const raw = typeof name === 'string' ? name.trim() : 'rect';
  const aliases: Record<string, string> = {
    rect: 'rect',
    rectangle: 'rect',
    roundrect: 'roundRect',
    round_rect: 'roundRect',
    rounded: 'roundRect',
    ellipse: 'ellipse',
    oval: 'ellipse',
    circle: 'ellipse',
    line: 'line',
    diamond: 'diamond',
    triangle: 'triangle',
  };
  const key = aliases[raw.toLowerCase()] ?? raw;
  if (pptx.ShapeType[key]) return pptx.ShapeType[key]!;
  // ShapeType values are same as keys for many
  if (Object.values(pptx.ShapeType).includes(key)) return key;
  return pptx.ShapeType.rect ?? 'rect';
}

function parseCoord(v: unknown, fallback: number): PptxCoord {
  if (typeof v === 'string' && v.trim().endsWith('%')) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return fallback;
}

function buildPptxTextPayload(obj: Record<string, unknown>): unknown {
  if (Array.isArray(obj.runs)) {
    return (obj.runs as unknown[]).map((r) => {
      if (typeof r === 'string') return { text: r, options: { breakLine: false } };
      const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const options: Record<string, unknown> = {};
      if (o.bold === true) options.bold = true;
      if (o.italic === true) options.italic = true;
      if (o.underline === true) options.underline = true;
      const color = normalizeHexColor(o.color);
      if (color) options.color = color;
      if (typeof o.size_pt === 'number') options.fontSize = clampNum(o.size_pt, 14, 6, 96);
      if (typeof o.fontSize === 'number') options.fontSize = clampNum(o.fontSize, 14, 6, 96);
      if (typeof o.font === 'string') options.fontFace = o.font;
      if (o.breakLine === true || o.break_line === true) options.breakLine = true;
      if (o.bullet === true) options.bullet = true;
      return { text: String(o.text ?? ''), options };
    });
  }
  return String(obj.text ?? '');
}

function applySlideObjects(
  pptx: PptxPres,
  slide: PptxSlide,
  objects: unknown[],
  cwd: string,
): void {
  if (objects.length > MAX_OBJECTS_PER_SLIDE) {
    throw new Error(
      `pptx objects too many (${objects.length} > ${MAX_OBJECTS_PER_SLIDE} per slide)`,
    );
  }
  for (const raw of objects) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const kind = String(o.kind ?? o.type ?? 'text').toLowerCase();
    const x = parseCoord(o.x, 0.5);
    const y = parseCoord(o.y, 0.5);
    const w = parseCoord(o.w, 4);
    const h = parseCoord(o.h, 1);

    if (kind === 'text') {
      const opts: Record<string, unknown> = {
        x,
        y,
        w,
        h,
        fontSize: clampNum(o.fontSize ?? o.size_pt, 16, 6, 96),
        color: normalizeHexColor(o.color) ?? '333333',
        valign: typeof o.valign === 'string' ? o.valign : 'top',
        align: typeof o.align === 'string' ? o.align : 'left',
      };
      if (o.bold === true) opts.bold = true;
      if (o.italic === true) opts.italic = true;
      if (o.underline === true) opts.underline = true;
      if (typeof o.font === 'string') opts.fontFace = o.font;
      if (typeof o.fontFace === 'string') opts.fontFace = o.fontFace;
      const fill = normalizeHexColor(o.fill);
      if (fill) opts.fill = { color: fill };
      if (o.bullet === true) opts.bullet = true;
      slide.addText(buildPptxTextPayload(o), opts);
      continue;
    }

    if (kind === 'shape') {
      const shape = mapShapeName(pptx, o.shape);
      const opts: Record<string, unknown> = { x, y, w, h };
      const fill = normalizeHexColor(o.fill ?? o.color);
      if (fill) opts.fill = { color: fill };
      const line = normalizeHexColor(o.line ?? o.line_color);
      if (line) {
        opts.line = {
          color: line,
          width: clampNum(o.line_width, 1, 0, 12),
        };
      }
      slide.addShape(shape, opts);
      continue;
    }

    if (kind === 'table') {
      const rowsRaw = Array.isArray(o.rows) ? o.rows : [];
      if (rowsRaw.length === 0) continue;
      let cells = 0;
      const tableRows = rowsRaw.map((row, ri) => {
        const cellsIn = Array.isArray(row) ? row : [row];
        cells += cellsIn.length;
        return cellsIn.map((cell) => {
          if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
            const c = cell as Record<string, unknown>;
            const cellOpts: Record<string, unknown> = {
              bold: c.bold === true || (ri === 0 && o.header !== false),
            };
            const fill = normalizeHexColor(c.fill);
            if (fill) cellOpts.fill = { color: fill };
            else if (ri === 0 && o.header !== false) {
              cellOpts.fill = { color: 'F0F0F0' };
            }
            return {
              text: String(c.text ?? c.value ?? ''),
              options: cellOpts,
            };
          }
          return {
            text: String(cell ?? ''),
            options: {
              bold: ri === 0 && o.header !== false,
              fill: ri === 0 && o.header !== false ? { color: 'F0F0F0' } : undefined,
            },
          };
        });
      });
      if (cells > MAX_TABLE_CELLS) {
        throw new Error(`pptx table too large (${cells} cells > ${MAX_TABLE_CELLS})`);
      }
      const opts: Record<string, unknown> = {
        x,
        y,
        w,
        fontSize: clampNum(o.fontSize, 12, 8, 32),
        color: normalizeHexColor(o.color) ?? '333333',
        border: [
          { pt: 0.5, color: 'CCCCCC' },
          { pt: 0.5, color: 'CCCCCC' },
          { pt: 0.5, color: 'CCCCCC' },
          { pt: 0.5, color: 'CCCCCC' },
        ],
        valign: 'middle',
      };
      if (Array.isArray(o.colW) || Array.isArray(o.col_w)) {
        opts.colW = (o.colW ?? o.col_w) as number[];
      }
      if (typeof o.h === 'number') opts.h = o.h;
      slide.addTable(tableRows, opts);
      continue;
    }

    if (kind === 'image') {
      const imgPath = typeof o.path === 'string' ? o.path.trim() : '';
      if (!imgPath) continue;
      const { abs } = resolveImageUnderCwd(cwd, imgPath);
      const imgOpts: Record<string, unknown> = { path: abs, x, y };
      if (o.w !== undefined) imgOpts.w = w;
      if (o.h !== undefined) imgOpts.h = h;
      slide.addImage(imgOpts);
      continue;
    }

    if (kind === 'chart') {
      const typeSource =
        o.chart_type ??
        o.chartType ??
        (typeof o.type === 'string' &&
        !['chart', 'text', 'shape', 'table', 'image'].includes(String(o.type).toLowerCase())
          ? o.type
          : 'bar');
      const finalType = mapChartType(pptx, typeSource);
      const series = buildChartSeries(o);
      const opts: Record<string, unknown> = {
        x,
        y,
        w: o.w !== undefined ? w : 9,
        h: o.h !== undefined ? h : 4,
        showLegend: o.show_legend === true || o.showLegend === true,
        showValue: o.show_value === true || o.showValue === true,
        showPercent: o.show_percent === true || o.showPercent === true,
      };
      if (typeof o.title === 'string' && o.title.trim()) {
        opts.title = o.title.trim();
        opts.showTitle = true;
      }
      if (Array.isArray(o.colors) || Array.isArray(o.chartColors)) {
        const colors = (o.colors ?? o.chartColors) as unknown[];
        opts.chartColors = colors
          .map((c) => normalizeHexColor(c))
          .filter((c): c is string => Boolean(c));
      }
      if (typeof o.bar_dir === 'string' || typeof o.barDir === 'string') {
        const dir = String(o.bar_dir ?? o.barDir).toLowerCase();
        opts.barDir = dir === 'bar' || dir === 'horizontal' ? 'bar' : 'col';
      }
      if (typeof o.legend_pos === 'string' || typeof o.legendPos === 'string') {
        opts.legendPos = o.legend_pos ?? o.legendPos;
      }
      slide.addChart(finalType, series, opts);
      continue;
    }
  }
}

async function writePptxFile(
  absPath: string,
  opts: {
    title?: string;
    layout?: string;
    slides: SlideInput[];
    masters?: MasterInput[];
    cwd: string;
  },
): Promise<void> {
  const pptx = new PptxGenJS();
  pptx.author = 'minimal-agent-ts';
  pptx.title = opts.title || 'Presentation';
  pptx.subject = opts.title || 'Presentation';

  const layoutName = opts.layout?.trim() || 'LAYOUT_16x9';
  const allowedLayouts = new Set([
    'LAYOUT_16x9',
    'LAYOUT_4x3',
    'LAYOUT_16x10',
    'LAYOUT_WIDE',
  ]);
  pptx.layout = allowedLayouts.has(layoutName) ? layoutName : 'LAYOUT_16x9';

  const masters = opts.masters ?? [];
  if (masters.length > 0) {
    applySlideMasters(pptx, masters, opts.cwd);
  }
  const masterNames = new Set(masters.map((m) => m.name));

  const slides =
    opts.slides.length > 0
      ? opts.slides
      : opts.title
        ? [{ title: opts.title, bullets: [] as string[] }]
        : [{ title: 'Slide 1', bullets: ['(empty)'] }];

  if (slides.length > MAX_SLIDES) {
    throw new Error(`pptx too many slides (${slides.length} > ${MAX_SLIDES})`);
  }

  for (const s of slides) {
    const masterName = s.master?.trim();
    if (masterName && !masterNames.has(masterName)) {
      throw new Error(
        `pptx slide master not defined: ${masterName} (available: ${[...masterNames].join(', ') || 'none'})`,
      );
    }
    const slide = masterName
      ? pptx.addSlide({ masterName })
      : pptx.addSlide();

    const bg = normalizeHexColor(s.background);
    if (bg) {
      slide.background = { color: bg };
    } else if (!masterName && resolveSlideLayout(s) === 'section') {
      slide.background = { color: '1E3A5F' };
    }

    const layout = resolveSlideLayout(s);
    applyPresetLayout(slide, s, layout);

    if (s.objects?.length) {
      applySlideObjects(pptx, slide, s.objects, opts.cwd);
    }

    if (s.notes?.trim()) {
      slide.addNotes(s.notes.trim());
    }
  }

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
    const result = await writeDocxFile(abs, args, config.cwd);
    const bits = [
      `ok: wrote docx ${rawPath}`,
      `mode=${result.mode}`,
      `blocks=${result.blocks}`,
    ];
    if (result.appended !== undefined) bits.push(`appended=${result.appended}`);
    bits.push(`sidecar=${basename(rawPath)}.office.json`);
    return bits.join(' · ');
  }

  if (kind === 'pptx') {
    const slides = parseSlides(args);
    const masters = parseMasters(args);
    const title = typeof args.title === 'string' ? args.title : undefined;
    const layout = typeof args.layout === 'string' ? args.layout : undefined;
    if (slides.length === 0 && !title) {
      return 'error: pptx write requires slides[] and/or title';
    }
    await writePptxFile(abs, {
      title,
      layout,
      slides,
      masters,
      cwd: config.cwd,
    });
    const n = slides.length > 0 ? slides.length : 1;
    const masterBit = masters.length > 0 ? `, masters=${masters.length}` : '';
    return `ok: wrote pptx ${rawPath} (${n} slides${layout ? `, layout=${layout}` : ''}${masterBit})`;
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
