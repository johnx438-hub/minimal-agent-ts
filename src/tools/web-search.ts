import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isCapabilityEnabled } from '../permission-gate.js';
import type { WebSearchPolicy } from '../plugins/types.js';
import type { AgentConfig, ToolDefinition } from '../types.js';
import { resolveDdgrCommand } from './cloak-resolve.js';
import { formatCacheHits, searchSpillCache } from './web-search-cache.js';

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CAP = 10;
const DEFAULT_MAX_EXTERNAL = 5;
const DEFAULT_WARN_AFTER = 3;
const DDGR_TIMEOUT_MS = 30_000;
const INLINE_MAX_CHARS = 6_000;

export const WEB_SEARCH_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the public web for discovery (title + snippet + URL). Checks local web_fetch cache first, then ddgr. Follow with web_fetch to read a chosen URL.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: {
            type: 'number',
            description: 'Max results (default 5, cap 10)',
          },
          region: {
            type: 'string',
            description: 'Optional region code for ddgr (-r)',
          },
          skip_cache: {
            type: 'boolean',
            description: 'Skip local spill cache and force external search',
          },
        },
        required: ['query'],
      },
    },
  },
];

export interface DdgrResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ResolvedWebSearchPolicy {
  allowed: boolean;
  backend: 'ddgr';
  ddgrPath: string;
  maxResultsDefault: number;
  maxResultsCap: number;
  cacheEnabled: boolean;
  spillDir: string;
  maxExternalPerTask: number;
  warnAfter: number;
  domainHints: string[];
}

export function resolveWebSearchPolicy(
  policy?: WebSearchPolicy,
): ResolvedWebSearchPolicy {
  const maxCap = Math.max(1, policy?.max_results_cap ?? DEFAULT_MAX_CAP);
  const maxDefault = Math.min(
    maxCap,
    Math.max(1, policy?.max_results_default ?? DEFAULT_MAX_RESULTS),
  );
  const ddgrResolved = resolveDdgrCommand(policy?.ddgr_path);
  return {
    allowed: policy?.allowed !== false,
    backend: 'ddgr',
    ddgrPath: ddgrResolved.command,
    maxResultsDefault: maxDefault,
    maxResultsCap: maxCap,
    cacheEnabled: policy?.cache?.enabled !== false,
    spillDir: policy?.cache?.search_spill_dir?.trim() || '.cache/web-fetch',
    maxExternalPerTask: Math.max(
      1,
      policy?.budget?.max_external_per_task ?? DEFAULT_MAX_EXTERNAL,
    ),
    warnAfter: Math.max(1, policy?.budget?.warn_after ?? DEFAULT_WARN_AFTER),
    domainHints: policy?.domain_hints ?? [],
  };
}

export function isWebSearchConfigured(config: AgentConfig): boolean {
  return resolveWebSearchPolicy(config.webSearchPolicy).allowed;
}

function clampResults(value: unknown, fallback: number, cap: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(cap, Math.max(1, Math.floor(n)));
}

function applyDomainHints(query: string, hints: string[]): string {
  if (hints.length === 0) return query.trim();
  const trimmed = query.trim();
  if (/\bsite:/i.test(trimmed)) return trimmed;
  const site = hints[0]!.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `${trimmed} site:${site}`;
}

export function parseDdgrJson(stdout: string): DdgrResult[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const results: DdgrResult[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const url = String(rec.url ?? rec.link ?? '').trim();
    if (!url) continue;
    const title = String(rec.title ?? url).trim();
    const snippet = String(rec.abstract ?? rec.snippet ?? rec.body ?? '').trim();
    results.push({ title, url, snippet });
  }
  return results;
}

export function formatDdgrResults(results: DdgrResult[]): string {
  if (results.length === 0) {
    return '[source: ddgr]\n(no results)';
  }
  const lines = results.map((r, i) => {
    const snippet = r.snippet ? `\n   ${r.snippet}` : '';
    return `${i + 1}. **${r.title}**\n   ${r.url}${snippet}`;
  });
  return `[source: ddgr]\n${lines.join('\n\n')}`;
}

export type RunDdgrFn = (
  ddgrPath: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

let runDdgrImpl: RunDdgrFn = runDdgrSubprocess;

export function setRunDdgrForTests(fn: RunDdgrFn | null): void {
  runDdgrImpl = fn ?? runDdgrSubprocess;
}

function runDdgrSubprocess(
  ddgrPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(ddgrPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: 127, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function runDdgrSearch(
  policy: ResolvedWebSearchPolicy,
  query: string,
  maxResults: number,
  region?: string,
): Promise<string> {
  const args = ['--json', '-n', String(maxResults)];
  if (region?.trim()) {
    args.push('-r', region.trim());
  }
  args.push(query);

  const { code, stdout, stderr } = await runDdgrImpl(
    policy.ddgrPath,
    args,
    DDGR_TIMEOUT_MS,
  );

  if (code === 127 || /ENOENT/i.test(stderr)) {
    return (
      'error: ddgr not found on PATH — install ddgr ' +
      '(Linux: apt/brew; Windows: pip install ddgr and ensure Scripts is on PATH; Git Bash: same PATH as Node). ' +
      'Or set web_search.ddgr_path / env DDGR_PATH to the full path of ddgr/ddgr.exe.'
    );
  }

  const results = parseDdgrJson(stdout);
  if (results.length === 0) {
    const detail = stderr.trim() || `exit ${code ?? 'unknown'}`;
    return `error: web_search failed (${detail}). Try rephrasing the query or use web_fetch with a known URL.`;
  }

  let out = formatDdgrResults(results);
  if (stderr.trim()) {
    out += `\n\n(ddgr stderr: ${stderr.trim().slice(0, 200)})`;
  }
  return out;
}

function searchArchivesLine(query: string, cwd: string): string {
  const path = resolve(cwd, '.agent/memory/archives.md');
  if (!existsSync(path)) return '';
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return '';

  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const hits: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (tokens.some((t) => lower.includes(t))) {
      hits.push(line.trim());
    }
    if (hits.length >= 2) break;
  }
  if (hits.length === 0) return '';
  return `[source: archives]\n${hits.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;
}

function budgetPrefix(
  policy: ResolvedWebSearchPolicy,
  externalCount: number,
): string {
  if (externalCount < policy.warnAfter) return '';
  return `[web_search: ${externalCount}/${policy.maxExternalPerTask} external this task]\n`;
}

export async function runWebSearchTool(
  toolName: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  if (toolName !== 'web_search') return null;

  const policy = resolveWebSearchPolicy(config.webSearchPolicy);
  if (!policy.allowed) {
    return 'error: web_search is disabled in agent.json (web_search.allowed: false)';
  }

  if (!isCapabilityEnabled(config, 'web')) {
    return 'error: web_search is disabled. Use /web on, /approve always web, or --allow-web.';
  }

  const query = String(args.query ?? '').trim();
  if (!query) {
    return 'error: query is required';
  }

  const maxResults = clampResults(
    args.max_results,
    policy.maxResultsDefault,
    policy.maxResultsCap,
  );
  const skipCache = args.skip_cache === true;
  const region = args.region !== undefined ? String(args.region) : undefined;
  const taskState = config.webSearchTaskState;

  const sections: string[] = [];

  if (policy.cacheEnabled && !skipCache) {
    const cacheHits = searchSpillCache(query, policy.spillDir, 3);
    const cacheText = formatCacheHits(cacheHits);
    if (cacheText) sections.push(cacheText);

    const archiveText = searchArchivesLine(query, config.cwd);
    if (archiveText) sections.push(archiveText);

    if (sections.length > 0) {
      const body = sections.join('\n\n');
      return `${body}\n\n(hint: use web_fetch on a URL above, or skip_cache:true for fresh ddgr results)`;
    }
  }

  const externalCount = taskState?.externalCount ?? 0;
  if (externalCount >= policy.maxExternalPerTask) {
    return (
      `error: web_search budget exhausted (${policy.maxExternalPerTask} external searches per task). ` +
      'Use web_fetch on a known URL, grep cache, or spawn_background(web-researcher).'
    );
  }

  if (taskState) {
    taskState.externalCount += 1;
  }

  const searchQuery = applyDomainHints(query, policy.domainHints);
  let result = await runDdgrSearch(policy, searchQuery, maxResults, region);
  if (result.startsWith('error:')) {
    return result;
  }

  const prefix = budgetPrefix(policy, taskState?.externalCount ?? externalCount + 1);
  result = prefix + result;

  if (result.length > INLINE_MAX_CHARS) {
    return `${result.slice(0, INLINE_MAX_CHARS)}…\n\n[truncated — narrow query or use web_fetch on one URL]`;
  }

  return `${result}\n\n(hint: pick a URL and call web_fetch for full content)`;
}