import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { getWorkspaceRoot } from '../workspace.js';

export interface SpillCacheHit {
  url: string;
  title: string;
  excerpt: string;
  path: string;
  score: number;
}

const MAX_SCAN_FILES = 120;
const EXCERPT_CHARS = 240;

function walkMarkdownFiles(dir: string, acc: string[]): void {
  if (acc.length >= MAX_SCAN_FILES || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (acc.length >= MAX_SCAN_FILES) return;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkMarkdownFiles(full, acc);
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      acc.push(full);
    }
  }
}

function parseFrontmatter(content: string): { url?: string; title?: string } {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 4);
  if (end < 0) return {};
  const block = content.slice(4, end);
  const meta: { url?: string; title?: string } = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^(url|title):\s*(.+)$/);
    if (!m) continue;
    const key = m[1] as 'url' | 'title';
    let value = m[2]!.trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = JSON.parse(value) as string;
    }
    meta[key] = value;
  }
  return meta;
}

function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function scoreHaystack(haystack: string, tokens: string[]): number {
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (lower.includes(token)) score += 1;
  }
  return score;
}

/** Match prior web_fetch spills under `.cache/web-fetch/`. */
export function searchSpillCache(
  query: string,
  spillDir = '.cache/web-fetch',
  limit = 3,
): SpillCacheHit[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];

  const root = resolve(getWorkspaceRoot(), spillDir.replace(/^\/+/, '') || '.cache/web-fetch');
  const files: string[] = [];
  walkMarkdownFiles(root, files);

  const hits: SpillCacheHit[] = [];
  for (const path of files) {
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(content);
    const url = fm.url ?? '';
    const title = fm.title ?? '';
    const bodyStart = content.indexOf('\n---\n');
    const body = bodyStart >= 0 ? content.slice(bodyStart + 5) : content;
    const excerpt = body.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS);
    const haystack = `${url} ${title} ${excerpt}`;
    const score = scoreHaystack(haystack, tokens);
    if (score <= 0) continue;
    hits.push({
      url: url || '(unknown url)',
      title: title || url || path,
      excerpt,
      path,
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export function formatCacheHits(hits: SpillCacheHit[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map((hit, i) => {
    const rel = relative(getWorkspaceRoot(), hit.path) || hit.path;
    return `${i + 1}. **${hit.title}**\n   ${hit.url}\n   ${hit.excerpt}\n   (cache: ${rel})`;
  });
  return `[source: cache]\n${lines.join('\n\n')}`;
}