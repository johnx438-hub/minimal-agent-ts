import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

import { isCapabilityEnabled } from '../permission-gate.js';
import type { AgentConfig, ToolDefinition } from '../types.js';
import type { WebFetchPolicy } from '../plugins/types.js';
import {
  formatSpillResult,
  markdownByteSize,
  writeWebFetchSpill,
} from './web-fetch-spill.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CLOAK_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_CHARS = 80_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_INLINE_BYTES = 512 * 1024;
const MIN_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const MIN_MAX_INLINE_BYTES = 16 * 1024;
const MAX_MAX_INLINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_SPILL_DIR = '.cache/web-fetch';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; minimal-agent-ts/0.1; +https://github.com/archer/zerostack-analysis)';

const BLOCKED_STATUS = new Set([401, 403, 407, 429, 451, 503]);

const BLOCKED_BODY_RE =
  /cloudflare|just a moment|enable javascript|access denied|please verify you are a human|datadome|incapsula|kasada|aws-waf|pardon our interruption|bot detection|captcha required/i;

export const WEB_FETCH_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch a public HTTP(S) URL and return LLM-friendly Markdown (title + main content). Large pages spill to .cache/web-fetch/ as Markdown (source URL preserved); use read_file with offset/limit. L2 cloakFetch optional.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTP or HTTPS URL to fetch' },
          timeout_ms: {
            type: 'number',
            description: 'L1 HTTP timeout in ms (default 15000, max 60000)',
          },
        },
        required: ['url'],
      },
    },
  },
];

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function resolvedPolicy(config: AgentConfig): Required<
  Pick<
    WebFetchPolicy,
    | 'allow_domains'
    | 'deny_domains'
    | 'default_timeout_ms'
    | 'cloak_timeout_ms'
    | 'max_chars'
    | 'max_response_bytes'
    | 'max_inline_bytes'
    | 'spill_enabled'
    | 'spill_dir'
    | 'user_agent'
    | 'cloak_fetch_enabled'
  >
> & {
  cloak_fetch_script?: string;
  cloak_browser_python?: string;
} {
  const p = config.webFetchPolicy ?? {};
  return {
    allow_domains: p.allow_domains ?? ['*'],
    deny_domains: p.deny_domains ?? [],
    default_timeout_ms: p.default_timeout_ms ?? DEFAULT_TIMEOUT_MS,
    cloak_timeout_ms: p.cloak_timeout_ms ?? DEFAULT_CLOAK_TIMEOUT_MS,
    max_chars: p.max_chars ?? DEFAULT_MAX_CHARS,
    max_response_bytes: clampInt(
      p.max_response_bytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MIN_MAX_RESPONSE_BYTES,
      MAX_MAX_RESPONSE_BYTES,
    ),
    max_inline_bytes: clampInt(
      p.max_inline_bytes,
      DEFAULT_MAX_INLINE_BYTES,
      MIN_MAX_INLINE_BYTES,
      MAX_MAX_INLINE_BYTES,
    ),
    spill_enabled: p.spill_enabled ?? true,
    spill_dir: (p.spill_dir?.trim() || DEFAULT_SPILL_DIR).replace(/^\/+/, ''),
    user_agent: p.user_agent ?? DEFAULT_USER_AGENT,
    cloak_fetch_enabled: p.cloak_fetch_enabled ?? false,
    cloak_fetch_script: p.cloak_fetch_script,
    cloak_browser_python: p.cloak_browser_python,
  };
}

function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map((x) => Number(x));
    if (octets.some((o) => o > 255)) return true;
    if (isPrivateIpv4(octets[0], octets[1])) return true;
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true; // CGNAT
  }

  if (host.includes(':')) {
    const h = host.replace(/^\[|\]$/g, '');
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) {
      return true;
    }
  }

  return false;
}

function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase().trim();
  if (!p || p === '*') return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith(`.${suffix}`);
  }
  return h === p;
}

function isDomainAllowed(host: string, policy: ReturnType<typeof resolvedPolicy>): boolean {
  if (isBlockedHost(host)) return false;
  for (const deny of policy.deny_domains) {
    if (hostMatchesPattern(host, deny)) return false;
  }
  for (const allow of policy.allow_domains) {
    if (hostMatchesPattern(host, allow)) return true;
  }
  return false;
}

function parseTargetUrl(raw: string): URL | string {
  const trimmed = raw.trim();
  if (!trimmed) return 'error: url is required';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'error: invalid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'error: only http and https URLs are allowed';
  }
  if (parsed.username || parsed.password) {
    return 'error: URLs with embedded credentials are not allowed';
  }
  return parsed;
}

function htmlToMarkdown(html: string, pageUrl: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  const article = new Readability(document, { charThreshold: 0 }).parse();
  const title = article?.title?.trim() || document.title?.trim() || pageUrl;

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
  });

  let bodyHtml = article?.content ?? '';
  if (!bodyHtml.trim()) {
    bodyHtml = document.body?.innerHTML ?? html;
  }

  const markdown = turndown.turndown(bodyHtml).trim() || '(no extractable content)';
  return { title, markdown };
}

function formatResult(
  url: string,
  title: string,
  markdown: string,
  via: 'http' | 'cloak',
  policy: ReturnType<typeof resolvedPolicy>,
): string {
  const header = [
    `[web_meta url=${url} title="${title.replace(/"/g, "'")}" via=${via}]`,
    `# ${title}`,
    '',
  ].join('\n');

  let body = markdown;
  const budget = policy.max_chars - header.length - 64;
  if (body.length > budget) {
    body = `${body.slice(0, Math.max(0, budget))}\n\n[truncated at ${budget} chars; use recall_query if pointerized]`;
  }

  return `${header}${body}`;
}

async function deliverMarkdownResult(
  url: string,
  title: string,
  markdown: string,
  via: 'http' | 'cloak',
  policy: ReturnType<typeof resolvedPolicy>,
  config: AgentConfig,
): Promise<string> {
  const shouldSpill =
    policy.spill_enabled && markdownByteSize(markdown) > policy.max_inline_bytes;

  if (!shouldSpill) {
    return formatResult(url, title, markdown, via, policy);
  }

  const spill = await writeWebFetchSpill({
    url,
    title,
    markdown,
    via,
    sessionId: config.sessionId,
    spillDir: policy.spill_dir,
  });
  return formatSpillResult(url, title, via, spill);
}

function looksBlocked(status: number, body: string): boolean {
  if (BLOCKED_STATUS.has(status)) return true;
  if (status >= 500 && BLOCKED_BODY_RE.test(body)) return true;
  return BLOCKED_BODY_RE.test(body.slice(0, 4000));
}

export class WebFetchResponseTooLargeError extends Error {
  readonly actualBytes: number;
  readonly limitBytes: number;

  constructor(actualBytes: number, limitBytes: number) {
    super(`response size ${actualBytes} exceeds max_response_bytes ${limitBytes}`);
    this.name = 'WebFetchResponseTooLargeError';
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
  }
}

/** Reject when Content-Length is known and over policy limit. */
export function checkContentLengthHeader(
  header: string | null,
  maxBytes: number,
): WebFetchResponseTooLargeError | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  const len = Number(trimmed);
  if (!Number.isFinite(len) || len < 0) return null;
  if (len > maxBytes) {
    return new WebFetchResponseTooLargeError(len, maxBytes);
  }
  return null;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Read a fetch body stream with a hard byte ceiling. */
export async function readBodyWithByteLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  abortSignal?: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      if (abortSignal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WebFetchResponseTooLargeError(total, maxBytes);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (!(err instanceof WebFetchResponseTooLargeError)) {
      await reader.cancel().catch(() => undefined);
    }
    throw err;
  }

  return new TextDecoder().decode(concatChunks(chunks));
}

function appendStdoutBounded(
  current: string,
  chunk: Buffer,
  maxBytes: number,
): { text: string; tooLarge: boolean } {
  const currentBytes = Buffer.byteLength(current, 'utf8');
  const chunkBytes = chunk.byteLength;
  if (currentBytes + chunkBytes <= maxBytes) {
    return { text: current + chunk.toString('utf8'), tooLarge: false };
  }
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) {
    return { text: current, tooLarge: true };
  }
  const partial = chunk.subarray(0, remaining).toString('utf8');
  return { text: current + partial, tooLarge: true };
}

function fetchAbortSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

async function fetchHttp(
  url: string,
  timeoutMs: number,
  userAgent: string,
  maxBytes: number,
  abortSignal?: AbortSignal,
): Promise<{ status: number; body: string; contentType: string }> {
  const signal = fetchAbortSignal(timeoutMs, abortSignal);
  const res = await fetch(url, {
    signal,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': userAgent,
    },
    redirect: 'follow',
  });

  const tooLarge = checkContentLengthHeader(res.headers.get('content-length'), maxBytes);
  if (tooLarge) throw tooLarge;

  const contentType = res.headers.get('content-type') ?? '';
  const body = res.body
    ? await readBodyWithByteLimit(res.body, maxBytes, abortSignal)
    : await res.text();
  if (!res.body && Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw new WebFetchResponseTooLargeError(Buffer.byteLength(body, 'utf8'), maxBytes);
  }
  return { status: res.status, body, contentType };
}

function discoverCloakScript(configured?: string): string | undefined {
  const candidates = [
    configured,
    process.env.CLOAK_FETCH_SCRIPT,
    resolve(homedir(), '.claude/skills/cloak-fetch/cloak_fetch.sh'),
    resolve(homedir(), 'github/cloakFetch/skills/cloak-fetch/cloak_fetch.sh'),
    resolve(homedir(), '.claude/hooks/cloak_fetch.py'),
  ].filter((c): c is string => Boolean(c?.trim()));

  for (const path of candidates) {
    const resolved = path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
    if (existsSync(resolved)) return resolved;
  }
  return undefined;
}

function cloakPython(configured?: string): string {
  if (configured?.trim()) return configured.trim();
  if (process.env.CLOAKBROWSER_PYTHON?.trim()) return process.env.CLOAKBROWSER_PYTHON.trim();
  const venv = resolve(homedir(), 'github/CloakBrowser/.venv/bin/python');
  if (existsSync(venv)) return venv;
  return 'python3';
}

async function runCloakFetch(
  url: string,
  policy: ReturnType<typeof resolvedPolicy>,
  abortSignal?: AbortSignal,
): Promise<string> {
  const script = discoverCloakScript(policy.cloak_fetch_script);
  if (!script) {
    return [
      'error: page appears blocked (403/anti-bot) and cloak_fetch is not configured.',
      'Install https://github.com/Agents365-ai/cloakFetch and set web_fetch_policy.cloak_fetch_script',
      'or CLOAK_FETCH_SCRIPT, then set cloak_fetch_enabled: true in agent.json.',
    ].join(' ');
  }

  const timeoutMs = policy.cloak_timeout_ms;
  const isPython = script.endsWith('.py');

  const maxBytes = policy.max_response_bytes;

  return new Promise((resolvePromise) => {
    const cmd = isPython ? cloakPython(policy.cloak_browser_python) : script;
    const args = isPython ? [script, url] : [url];
    const env = { ...process.env };
    if (policy.cloak_browser_python) {
      env.CLOAKBROWSER_PYTHON = policy.cloak_browser_python;
    }

    const child = spawn(cmd, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolvePromise(value);
    };

    const onAbort = (): void => {
      child.kill('SIGTERM');
      finish('error: cloak_fetch aborted');
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      const next = appendStdoutBounded(stdout, chunk, maxBytes);
      stdout = next.text;
      if (next.tooLarge) {
        child.kill('SIGTERM');
        finish(
          `error: cloak_fetch output exceeds max_response_bytes ${maxBytes}`,
        );
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(`error: cloak_fetch timed out after ${timeoutMs}ms\n${stderr.trim()}`.trim());
    }, timeoutMs);

    child.on('error', (err) => {
      finish(`error: cloak_fetch failed to start: ${err.message}`);
    });

    child.on('close', (code) => {
      const out = stdout.trim();
      if (code !== 0 || !out) {
        const detail = [stderr.trim(), out].filter(Boolean).join('\n');
        finish(`error: cloak_fetch exited ${code ?? 'null'}${detail ? `\n${detail}` : ''}`);
        return;
      }
      finish(out);
    });
  });
}

export async function runWebFetchTool(
  toolName: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  if (toolName !== 'web_fetch') return null;

  if (!isCapabilityEnabled(config, 'web')) {
    return 'error: web_fetch is disabled. Use /web on, /approve always web, or --allow-web.';
  }

  const parsed = parseTargetUrl(String(args.url ?? ''));
  if (typeof parsed === 'string') return parsed;

  const policy = resolvedPolicy(config);
  if (!isDomainAllowed(parsed.hostname, policy)) {
    return `error: domain not allowed: ${parsed.hostname} (check web_fetch_policy.allow_domains)`;
  }

  const timeoutMs = clampInt(args.timeout_ms, policy.default_timeout_ms, 3_000, 60_000);
  const url = parsed.toString();

  try {
    const { status, body, contentType } = await fetchHttp(
      url,
      timeoutMs,
      policy.user_agent,
      policy.max_response_bytes,
      config.abortSignal,
    );

    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      if (status >= 400) {
        return `error: HTTP ${status} (${contentType || 'unknown type'})`;
      }
      const preview = body.slice(0, 2000);
      return formatResult(
        url,
        url,
        `\`\`\`\n${preview}${body.length > 2000 ? '\n…' : ''}\n\`\`\``,
        'http',
        policy,
      );
    }

    if (!looksBlocked(status, body)) {
      const { title, markdown } = htmlToMarkdown(body, url);
      return deliverMarkdownResult(url, title, markdown, 'http', policy, config);
    }

    if (!policy.cloak_fetch_enabled) {
      return [
        `error: HTTP ${status} — page may be bot-protected.`,
        'Enable web_fetch_policy.cloak_fetch_enabled and configure cloak_fetch_script for L2 fallback.',
      ].join(' ');
    }

    const cloakOut = await runCloakFetch(url, policy, config.abortSignal);
    if (cloakOut.startsWith('error:')) return cloakOut;

    const titleMatch = cloakOut.match(/^#\s+(.+)/m);
    const title = titleMatch?.[1]?.trim() ?? url;
    return deliverMarkdownResult(url, title, cloakOut, 'cloak', policy, config);
  } catch (err) {
    if (err instanceof WebFetchResponseTooLargeError) {
      return `error: ${err.message}`;
    }
    if (
      (err instanceof DOMException && err.name === 'AbortError') ||
      (err instanceof Error && err.name === 'AbortError')
    ) {
      if (config.abortSignal?.aborted) {
        return 'error: fetch aborted';
      }
      return `error: fetch timed out after ${timeoutMs}ms`;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/timeout/i.test(msg)) {
      return `error: fetch timed out after ${timeoutMs}ms`;
    }
    return `error: fetch failed: ${msg}`;
  }
}