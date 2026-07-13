/**
 * C4: test_run — run a test command and return a structured pass/fail summary.
 * Full output is truncated/spilled so ReAct context stays small.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import type { AgentConfig, ToolDefinition } from '../types.js';
import { runShellCommand } from './shell.js';

const DEFAULT_COMMAND = 'npm test';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_FAILURES_LISTED = 15;
const INLINE_TAIL_CHARS = 4_000;
const SPILL_THRESHOLD_CHARS = 8_000;

export const TEST_RUN_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'test_run',
      description:
        'Run a test command (default: npm test) and return a structured summary: pass/fail/skip counts, listed failures, exit code. ' +
        'Prefer over raw run_shell for verification — keeps context small; full log may spill to .cache/test-run/. Requires shell permission.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: `Shell command to run (default "${DEFAULT_COMMAND}").`,
          },
          timeout_ms: {
            type: 'number',
            description: `Initial timeout in ms (default ${DEFAULT_TIMEOUT_MS}).`,
          },
          max_timeout_ms: {
            type: 'number',
            description: `Max timeout with auto-extend (default ${DEFAULT_MAX_TIMEOUT_MS}).`,
          },
          max_failures: {
            type: 'number',
            description: `Max failure names to list in summary (default ${DEFAULT_MAX_FAILURES_LISTED}).`,
          },
          spill: {
            type: 'boolean',
            description: 'Write full log under .cache/test-run/ when large (default true).',
          },
        },
      },
    },
  },
];

export interface TestRunSummary {
  pass: number;
  fail: number;
  skip: number;
  total: number;
  /** Detected format label */
  format: 'node-test' | 'tap' | 'jest-like' | 'junit' | 'exit-only' | 'unknown';
  failures: string[];
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Parse node:test reporter footer (ℹ tests / pass / fail / skipped). */
export function parseNodeTestOutput(text: string): Partial<TestRunSummary> | null {
  const tests = text.match(/ℹ\s+tests\s+(\d+)/);
  const pass = text.match(/ℹ\s+pass\s+(\d+)/);
  const fail = text.match(/ℹ\s+fail\s+(\d+)/);
  const skip = text.match(/ℹ\s+skipped\s+(\d+)/);
  if (!tests && !pass && !fail) return null;

  const total = tests ? Number(tests[1]) : 0;
  const p = pass ? Number(pass[1]) : 0;
  const f = fail ? Number(fail[1]) : 0;
  const s = skip ? Number(skip[1]) : 0;

  const failures: string[] = [];
  // ✖ test name  or  ✖ suite > name
  for (const m of text.matchAll(/✖\s+(.+?)(?:\s+\([\d.]+ms\))?\s*$/gm)) {
    const name = m[1]!.trim();
    if (name && !name.startsWith('failing tests')) failures.push(name);
  }

  return {
    format: 'node-test',
    total: total || p + f + s,
    pass: p,
    fail: f,
    skip: s,
    failures,
  };
}

/** Parse TAP (Test Anything Protocol). */
export function parseTapOutput(text: string): Partial<TestRunSummary> | null {
  const plan = text.match(/^1\.\.(\d+)\s*$/m);
  const passCount = [...text.matchAll(/^ok\s+\d+/gm)].length;
  const failCount = [...text.matchAll(/^not ok\s+\d+/gm)].length;
  const footerTests = text.match(/^#\s+tests\s+(\d+)/m);
  const footerPass = text.match(/^#\s+pass\s+(\d+)/m);
  const footerFail = text.match(/^#\s+fail\s+(\d+)/m);
  const footerSkip = text.match(/^#\s+skip\s+(\d+)/m);

  if (!plan && passCount === 0 && failCount === 0 && !footerTests) return null;

  const failures: string[] = [];
  for (const m of text.matchAll(/^not ok\s+\d+\s+-?\s*(.*)$/gm)) {
    const name = m[1]!.trim() || `not ok ${failures.length + 1}`;
    failures.push(name);
  }

  const total =
    footerTests
      ? Number(footerTests[1])
      : plan
        ? Number(plan[1])
        : passCount + failCount;
  const pass = footerPass ? Number(footerPass[1]) : passCount;
  const fail = footerFail ? Number(footerFail[1]) : failCount;
  const skip = footerSkip ? Number(footerSkip[1]) : 0;

  return {
    format: 'tap',
    total,
    pass,
    fail,
    skip,
    failures,
  };
}

/** Parse Jest / Vitest style summary lines. */
export function parseJestLikeOutput(text: string): Partial<TestRunSummary> | null {
  // Tests:       1 failed, 2 passed, 3 total
  const testsLine = text.match(
    /Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+passed,\s*)?(?:(\d+)\s+skipped,\s*)?(\d+)\s+total/i,
  );
  // Test Files  1 failed | 2 passed (3)
  const filesLine = text.match(
    /Test Files\s+(?:(\d+)\s+failed\s*\|?\s*)?(?:(\d+)\s+passed)?/i,
  );
  // ✓ name (1ms) / × name / FAIL path
  if (!testsLine && !filesLine && !/FAIL\s+\S+/.test(text) && !/✓|×|✔|✖/.test(text)) {
    return null;
  }

  let fail = 0;
  let pass = 0;
  let skip = 0;
  let total = 0;

  if (testsLine) {
    fail = Number(testsLine[1] ?? 0);
    pass = Number(testsLine[2] ?? 0);
    skip = Number(testsLine[3] ?? 0);
    total = Number(testsLine[4] ?? fail + pass + skip);
  } else if (filesLine) {
    fail = Number(filesLine[1] ?? 0);
    pass = Number(filesLine[2] ?? 0);
    total = fail + pass;
  }

  const failures: string[] = [];
  for (const m of text.matchAll(/^(?:FAIL|✕|×|✖)\s+(.+)$/gm)) {
    failures.push(m[1]!.trim());
  }
  for (const m of text.matchAll(/^\s*●\s+(.+)$/gm)) {
    failures.push(m[1]!.trim());
  }

  if (total === 0 && pass === 0 && fail === 0 && failures.length === 0) return null;

  return {
    format: 'jest-like',
    total: total || pass + fail + skip || failures.length,
    pass,
    fail: fail || failures.length,
    skip,
    failures,
  };
}

function readXmlAttr(tag: string, name: string): number | undefined {
  const m = tag.match(new RegExp(`\\b${name}="(\\d+)"`));
  return m ? Number(m[1]) : undefined;
}

/** Parse minimal JUnit XML counts. */
export function parseJunitXml(text: string): Partial<TestRunSummary> | null {
  if (!/<testsuite[\s>]/.test(text) && !/<testsuites[\s>]/.test(text)) return null;

  let tests = 0;
  let failures = 0;
  let skipped = 0;
  let errors = 0;

  // Prefer root <testsuites ...> once if present.
  const root = text.match(/<testsuites\b[^>]*>/);
  if (root) {
    tests = readXmlAttr(root[0], 'tests') ?? 0;
    failures = readXmlAttr(root[0], 'failures') ?? 0;
    errors = readXmlAttr(root[0], 'errors') ?? 0;
    skipped = readXmlAttr(root[0], 'skipped') ?? 0;
  }

  if (tests === 0 && failures === 0) {
    for (const m of text.matchAll(/<testsuite\b[^>]*>/g)) {
      tests += readXmlAttr(m[0], 'tests') ?? 0;
      failures += readXmlAttr(m[0], 'failures') ?? 0;
      errors += readXmlAttr(m[0], 'errors') ?? 0;
      skipped += readXmlAttr(m[0], 'skipped') ?? 0;
    }
  }

  const failNames: string[] = [];
  for (const m of text.matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    const body = m[2];
    if (body === undefined) continue; // self-closing success case
    if (!/<(failure|error)\b/.test(body)) continue;
    const name = readXmlAttrName(m[1] ?? '');
    if (name) failNames.push(name);
  }

  if (tests === 0 && failures === 0 && failNames.length === 0) return null;

  const fail = failures + errors || failNames.length;
  return {
    format: 'junit',
    total: tests || fail + skipped,
    pass: Math.max(0, (tests || 0) - fail - skipped),
    fail,
    skip: skipped,
    failures: failNames,
  };
}

function readXmlAttrName(attrs: string): string | undefined {
  const m = attrs.match(/\bname="([^"]+)"/);
  return m?.[1];
}

/**
 * Build a structured summary from combined stdout/stderr and process exit code.
 */
export function summarizeTestOutput(
  output: string,
  exitCode: number | null,
  opts?: { timedOut?: boolean; aborted?: boolean },
): TestRunSummary {
  const aborted = opts?.aborted === true || output.includes('[aborted]');
  const timedOut =
    opts?.timedOut === true || /timed out|command timed out/i.test(output);

  const parsers = [
    parseNodeTestOutput,
    parseTapOutput,
    parseJestLikeOutput,
    parseJunitXml,
  ];

  for (const parse of parsers) {
    const partial = parse(output);
    if (!partial) continue;
    const pass = partial.pass ?? 0;
    const fail = partial.fail ?? 0;
    const skip = partial.skip ?? 0;
    const total = partial.total ?? pass + fail + skip;
    return {
      format: partial.format ?? 'unknown',
      pass,
      fail,
      skip,
      total,
      failures: partial.failures ?? [],
      exitCode,
      timedOut,
      aborted,
    };
  }

  // Fallback: exit code only
  const ok = exitCode === 0 && !timedOut && !aborted;
  return {
    format: 'exit-only',
    pass: ok ? 1 : 0,
    fail: ok ? 0 : 1,
    skip: 0,
    total: 1,
    failures: ok ? [] : ['(no structured test counts; see log / exit code)'],
    exitCode,
    timedOut,
    aborted,
  };
}

export function formatTestRunMarkdown(
  summary: TestRunSummary,
  opts: {
    command: string;
    elapsedMs?: number;
    spillPath?: string;
    tail?: string;
    maxFailures: number;
  },
): string {
  const status =
    summary.aborted
      ? 'ABORTED'
      : summary.timedOut
        ? 'TIMEOUT'
        : summary.fail > 0 || (summary.exitCode !== null && summary.exitCode !== 0)
          ? 'FAIL'
          : 'PASS';

  const lines = [
    `### test_run — **${status}**`,
    `command: \`${opts.command}\``,
    `format: ${summary.format}`,
    `counts: pass=${summary.pass} fail=${summary.fail} skip=${summary.skip} total=${summary.total}`,
    `exit: ${summary.exitCode === null ? 'null' : summary.exitCode}`,
  ];
  if (opts.elapsedMs !== undefined) {
    lines.push(`elapsed_ms: ${opts.elapsedMs}`);
  }
  if (summary.failures.length > 0) {
    lines.push('', '**Failures**');
    for (const f of summary.failures.slice(0, opts.maxFailures)) {
      lines.push(`- ${f}`);
    }
    if (summary.failures.length > opts.maxFailures) {
      lines.push(`- … +${summary.failures.length - opts.maxFailures} more`);
    }
  }
  if (opts.spillPath) {
    lines.push('', `full log: \`${opts.spillPath}\` (use read_file)`);
  }
  if (opts.tail && opts.tail.trim()) {
    lines.push('', '**Log tail**', '```text', opts.tail.trimEnd(), '```');
  }
  return lines.join('\n');
}

function extractExitCode(shellOutput: string): number | null {
  const m = shellOutput.match(/^error: exit (\d+)/m);
  if (m) return Number(m[1]);
  if (shellOutput.startsWith('error:')) return 1;
  if (shellOutput.includes('[aborted]')) return null;
  return 0;
}

function stripShellMeta(output: string): string {
  return output.replace(/^\[shell:[^\]]+\]\n?/, '');
}

function maybeSpill(
  cwd: string,
  command: string,
  fullLog: string,
  enabled: boolean,
): string | undefined {
  if (!enabled || fullLog.length < SPILL_THRESHOLD_CHARS) return undefined;
  const dir = resolve(cwd, '.cache', 'test-run');
  mkdirSync(dir, { recursive: true });
  const hash = createHash('sha256').update(command).update(fullLog).digest('hex').slice(0, 12);
  const rel = join('.cache', 'test-run', `${hash}.log`);
  const abs = resolve(cwd, rel);
  writeFileSync(abs, fullLog, 'utf8');
  return rel;
}

export async function runTestRunTool(
  toolName: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  if (toolName !== 'test_run') return null;

  const command =
    typeof args.command === 'string' && args.command.trim()
      ? args.command.trim()
      : DEFAULT_COMMAND;
  const timeoutMs = clampInt(args.timeout_ms, DEFAULT_TIMEOUT_MS, 5_000, 600_000);
  let maxTimeoutMs = clampInt(
    args.max_timeout_ms,
    DEFAULT_MAX_TIMEOUT_MS,
    timeoutMs,
    600_000,
  );
  if (maxTimeoutMs < timeoutMs) maxTimeoutMs = timeoutMs;
  const maxFailures = clampInt(
    args.max_failures,
    DEFAULT_MAX_FAILURES_LISTED,
    1,
    100,
  );
  const spill = args.spill !== false;

  const started = Date.now();
  const raw = await runShellCommand({
    cwd: config.cwd,
    command,
    delayMs: 0,
    timeoutMs,
    pollIntervalMs: 2_000,
    autoExtend: true,
    extendByMs: 30_000,
    maxTimeoutMs,
    abortSignal: config.abortSignal,
  });
  const elapsedMs = Date.now() - started;

  const body = stripShellMeta(raw);
  const exitCode = extractExitCode(raw);
  const timedOut = /timed out/i.test(raw);
  const aborted = raw.includes('[aborted]') || Boolean(config.abortSignal?.aborted);

  const summary = summarizeTestOutput(body, exitCode, { timedOut, aborted });
  const spillPath = maybeSpill(config.cwd, command, body, spill && !aborted);
  const tail =
    body.length > INLINE_TAIL_CHARS
      ? body.slice(-INLINE_TAIL_CHARS)
      : body.length > 0 && !spillPath
        ? body
        : spillPath
          ? body.slice(-Math.min(2000, INLINE_TAIL_CHARS))
          : body;

  return formatTestRunMarkdown(summary, {
    command,
    elapsedMs,
    spillPath,
    tail: summary.format === 'exit-only' || summary.fail > 0 || timedOut ? tail : undefined,
    maxFailures,
  });
}
