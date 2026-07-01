import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { getWorkspaceRoot } from '../workspace.js';

export interface WebFetchSpillInput {
  url: string;
  title: string;
  markdown: string;
  via: 'http' | 'cloak';
  sessionId?: string;
  /** Relative to workspace root. Default `.cache/web-fetch`. */
  spillDir?: string;
}

export interface WebFetchSpillResult {
  relativePath: string;
  bytes: number;
  lines: number;
}

function sanitizeBucket(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) return 'default';
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function webFetchCacheDir(sessionId?: string, spillDir = '.cache/web-fetch'): string {
  const base = spillDir.replace(/^\/+/, '') || '.cache/web-fetch';
  return resolve(getWorkspaceRoot(), base, sanitizeBucket(sessionId ?? ''));
}

function urlHash8(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 8);
}

function spillFileName(url: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ts}-${urlHash8(url)}.md`;
}

function yamlScalar(value: string): string {
  if (/^[\w\s().,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/** Markdown file with YAML frontmatter (url preserved for human review). */
export function buildSpillDocument(input: WebFetchSpillInput): string {
  const fetchedAt = new Date().toISOString();
  const frontmatter = [
    '---',
    `url: ${input.url}`,
    `title: ${yamlScalar(input.title)}`,
    `fetched_at: ${fetchedAt}`,
    `via: ${input.via}`,
    'note: Markdown via Readability+Turndown; open url in a browser if layout/tables look wrong.',
    '---',
    '',
  ].join('\n');

  const body = input.markdown.trim() || '(no extractable content)';
  return `${frontmatter}# ${input.title}\n\n${body}`;
}

export async function writeWebFetchSpill(
  input: WebFetchSpillInput,
): Promise<WebFetchSpillResult> {
  const dir = webFetchCacheDir(input.sessionId, input.spillDir);
  await mkdir(dir, { recursive: true });

  const content = buildSpillDocument(input);
  const fileName = spillFileName(input.url);
  const fullPath = resolve(dir, fileName);
  await writeFile(fullPath, content, 'utf8');

  return {
    relativePath: relative(getWorkspaceRoot(), fullPath),
    bytes: Buffer.byteLength(content, 'utf8'),
    lines: content.split('\n').length,
  };
}

export function formatSpillResult(
  url: string,
  title: string,
  via: 'http' | 'cloak',
  spill: WebFetchSpillResult,
): string {
  const safeTitle = title.replace(/"/g, "'");
  return [
    `[web_spill url=${url} title="${safeTitle}" via=${via}]`,
    `saved=${spill.relativePath}`,
    `bytes=${spill.bytes} lines=${spill.lines}`,
    `source_url=${url}`,
    `read=read_file(path="${spill.relativePath}", offset=1, limit=200)`,
    'hint=Markdown saved under workspace; read in chunks with offset/limit.',
    'hint=Open source_url in a browser if Readability/Turndown conversion looks wrong.',
    'note=Tables/code blocks may be lossy in converted Markdown.',
  ].join('\n');
}

export function markdownByteSize(markdown: string): number {
  return Buffer.byteLength(markdown, 'utf8');
}