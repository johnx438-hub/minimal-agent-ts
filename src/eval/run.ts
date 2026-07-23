import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';

import { previewPolicyFromPointerize } from '../action-preview.js';
import { mergeContextPolicy, normalizeContextPolicy } from '../context/policy-config.js';
import type { RuntimeEvent } from '../events.js';
import { AgentRuntime } from '../runner.js';
import type { AgentPluginConfig } from '../plugins/types.js';
import type { AgentConfig } from '../types.js';
import {
  gitSha,
  loadStrategy,
  loadTaskMeta,
  readTaskPrompt,
  resolveEvalRoot,
  taskDir,
} from './load.js';
import {
  computeHotTokenStats,
  computeRepeatToolRate,
  EvalTelemetryCollector,
} from './telemetry.js';
import type {
  EvalManifest,
  EvalRunOptions,
  EvalSummary,
  EvalTurnRecord,
} from './types.js';

function packageVersion(projectRoot: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(projectRoot, 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function baseUrlHost(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function makeRunId(taskId: string, strategyId: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${taskId}__${strategyId}__${ts}`;
}

function applyStrategyToConfig(
  config: AgentConfig,
  pluginConfig: AgentPluginConfig,
  strategy: ReturnType<typeof loadStrategy>,
): void {
  if (strategy.pointerize_policy) {
    pluginConfig.pointerize_policy = {
      ...pluginConfig.pointerize_policy,
      ...strategy.pointerize_policy,
    };
    config.pointerizePolicy = pluginConfig.pointerize_policy;
    config.keepInlineTurns =
      pluginConfig.pointerize_policy?.keep_inline_turns ?? config.keepInlineTurns ?? 2;
    config.previewPolicy = previewPolicyFromPointerize(pluginConfig.pointerize_policy);
  }
  if (strategy.context_policy !== undefined) {
    pluginConfig.context_policy = mergeContextPolicy(
      pluginConfig.context_policy,
      strategy.context_policy,
    );
    config.contextPolicy = normalizeContextPolicy(pluginConfig.context_policy);
  }
}

function runSetup(taskRoot: string, workdir: string): void {
  const setup = join(taskRoot, 'setup.sh');
  if (!existsSync(setup)) {
    throw new Error(`missing setup.sh: ${setup}`);
  }
  const r = spawnSync('bash', [setup], {
    encoding: 'utf8',
    env: { ...process.env, EVAL_WORKDIR: workdir },
  });
  if (r.status !== 0) {
    throw new Error(`setup failed: ${r.stderr || r.stdout || `exit ${r.status}`}`);
  }
}

function runScore(taskRoot: string, workdir: string): { ok: boolean; raw: unknown } {
  const score = join(taskRoot, 'score.sh');
  if (!existsSync(score)) {
    throw new Error(`missing score.sh: ${score}`);
  }
  const r = spawnSync('bash', [score], {
    encoding: 'utf8',
    env: { ...process.env, EVAL_WORKDIR: workdir },
  });
  let raw: unknown = { exit: r.status, stdout: r.stdout?.trim() };
  try {
    if (r.stdout?.trim()) raw = JSON.parse(r.stdout.trim());
  } catch {
    /* keep raw */
  }
  return { ok: r.status === 0, raw };
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
    'utf8',
  );
}

function envPricePer1M(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Optional USD estimate from env prices ($ / 1M tokens). */
export function estimateCostUsd(
  promptTokens: number,
  completionTokens: number,
): number | null {
  const p = envPricePer1M('EVAL_PRICE_PROMPT_PER_1M');
  const c = envPricePer1M('EVAL_PRICE_COMPLETION_PER_1M');
  if (p === null && c === null) return null;
  const cost =
    (promptTokens / 1_000_000) * (p ?? 0) +
    (completionTokens / 1_000_000) * (c ?? 0);
  return Math.round(cost * 1e6) / 1e6;
}

function buildSummary(
  manifest: EvalManifest,
  records: EvalTurnRecord[],
  score: { ok: boolean; raw: unknown },
  finalText: string,
  error?: string,
): EvalSummary {
  const repeat = computeRepeatToolRate(records);
  const hot = computeHotTokenStats(records);
  const completion = records.reduce((s, r) => s + (r.completion_tokens ?? 0), 0);
  let compressionEvents = 0;
  let heavy = 0;
  let loop = 0;
  for (const r of records) {
    if (
      (r.pointerized ?? 0) > 0 ||
      (r.pruned ?? 0) > 0 ||
      (r.pointer_compacted ?? 0) > 0 ||
      r.heavy_compression
    ) {
      compressionEvents += 1;
    }
    if (r.heavy_compression) heavy += 1;
    loop += r.loop_guard_actions.length;
  }

  const cost_usd_est = estimateCostUsd(hot.sum, completion);

  return {
    run_id: manifest.run_id,
    task_id: manifest.task_id,
    strategy_id: manifest.strategy_id,
    task_success: score.ok,
    score: score.raw,
    turns_used: records.length,
    repeat_tool_rate: Math.round(repeat.rate * 10000) / 10000,
    hot_tokens_mean:
      hot.mean === null ? null : Math.round(hot.mean * 10) / 10,
    hot_tokens_p95: hot.p95,
    prompt_tokens_total: hot.sum,
    completion_tokens_total: completion,
    tool_calls_total: repeat.total,
    compression_events: compressionEvents,
    heavy_compression_count: heavy,
    loop_guard_count: loop,
    final_text_preview: finalText.slice(0, 500),
    cost_usd_est,
    ...(error ? { error } : {}),
  };
}

export interface EvalRunResult {
  runDir: string;
  manifest: EvalManifest;
  summary: EvalSummary;
  turns: EvalTurnRecord[];
}

/**
 * Run one eval: setup → (optional LLM) → score → write artifacts under eval/runs/<id>/.
 */
export async function runEval(opts: EvalRunOptions): Promise<EvalRunResult> {
  const projectRoot = opts.projectRoot;
  // Load .env from project root (eval CLI may not inherit TUI/main dotenv).
  // path: prefer projectRoot/.env so cwd-independent library callers work.
  loadDotenv({ path: join(projectRoot, '.env'), override: false });

  const evalRoot = resolveEvalRoot(projectRoot, opts.evalRoot);
  const taskId = opts.taskId;
  const strategyId = opts.strategyId;
  const dryRun = Boolean(opts.dryRun);
  const meta = loadTaskMeta(evalRoot, taskId);
  const strategy = loadStrategy(evalRoot, strategyId);
  const taskRoot = taskDir(evalRoot, taskId);
  const maxTurns = opts.maxTurns ?? meta.max_turns ?? 30;
  const timeoutSec = opts.timeoutSec ?? meta.timeout_sec ?? null;
  const runId = makeRunId(taskId, strategyId, opts.runId);
  const runsDir = opts.runsDir ?? join(evalRoot, 'runs');
  const runDir = join(runsDir, runId);
  // Per-run sandbox (avoids races when multiple evals share a task id).
  const workdir = join(runDir, 'workspace');
  mkdirSync(runDir, { recursive: true });

  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  runSetup(taskRoot, workdir);

  if (dryRun && opts.plantCorrectAnswer) {
    const correct = join(taskRoot, 'fixtures', 'answer.correct.json');
    if (!existsSync(correct)) {
      throw new Error(`missing ${correct} for plantCorrectAnswer`);
    }
    copyFileSync(correct, join(workdir, 'answer.json'));
    mkdirSync(join(workdir, 'data'), { recursive: true });
    const expected = JSON.parse(
      readFileSync(join(taskRoot, 'expected.json'), 'utf8'),
    ) as { token?: string };
    if (expected.token) {
      writeFileSync(join(workdir, 'data', 'claimed_token.txt'), `${expected.token}\n`);
    }
  }

  let finalText = '';
  let model = '';
  let baseHost: string | null = null;
  let error: string | undefined;
  const collector = new EvalTelemetryCollector();
  const eventsPath = join(runDir, 'events.jsonl');
  const eventLines: string[] = [];

  const manifest: EvalManifest = {
    schema_version: 1,
    run_id: runId,
    task_id: taskId,
    strategy_id: strategyId,
    git_sha: gitSha(projectRoot),
    package_version: packageVersion(projectRoot),
    model: '',
    base_url_host: null,
    max_turns: maxTurns,
    timeout_sec: timeoutSec,
    allow_shell: Boolean(opts.allowShell),
    allow_web: Boolean(opts.allowWeb),
    workdir,
    project_root: projectRoot,
    dry_run: dryRun,
    started_at: startedAt,
    pointerize_policy: strategy.pointerize_policy,
    context_policy: strategy.context_policy,
    task_meta: meta,
  };

  if (!dryRun) {
    const runtime = new AgentRuntime({
      cwd: projectRoot,
      allowShell: opts.allowShell ?? false,
      allowWeb: opts.allowWeb ?? false,
      // Prefer short sessions under runs/ when possible; tools still use sandbox cwd.
      jsonEvents: false,
    });

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await runtime.initialize();
      applyStrategyToConfig(runtime.config, runtime.pluginConfig, strategy);
      runtime.config.cwd = workdir;
      runtime.config.maxTurns = maxTurns;
      model = runtime.config.model;
      baseHost = baseUrlHost(runtime.config.baseUrl);
      manifest.model = model;
      manifest.base_url_host = baseHost;

      // Auto-approve path_escape if needed? keep default deny outside sandbox.

      runtime.onEvent((event: RuntimeEvent) => {
        const ts = Date.now();
        collector.onEvent(event, ts);
        eventLines.push(JSON.stringify({ ts, event }));
      });

      if (timeoutSec && timeoutSec > 0) {
        timeoutTimer = setTimeout(() => {
          runtime.abort();
        }, timeoutSec * 1000);
      }

      const prompt = readTaskPrompt(evalRoot, taskId);
      const result = await runtime.runTask(prompt);
      finalText = result.text;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      finalText = error;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      await runtime.shutdown().catch(() => undefined);
    }
  } else {
    manifest.model = 'dry-run';
    finalText = opts.plantCorrectAnswer
      ? '[dry-run planted correct answer]'
      : '[dry-run no LLM]';
  }

  const turns = collector.toRecords();
  const score = runScore(taskRoot, workdir);
  const finished = Date.now();
  manifest.finished_at = new Date(finished).toISOString();
  manifest.wall_ms = finished - started;
  if (!manifest.model) manifest.model = model || 'unknown';

  writeJson(join(runDir, 'manifest.json'), manifest);
  writeJsonl(
    join(runDir, 'turns.jsonl'),
    turns.map((t) => t),
  );
  if (eventLines.length) {
    writeFileSync(eventsPath, eventLines.join('\n') + '\n', 'utf8');
  }
  writeFileSync(join(runDir, 'final.txt'), finalText, 'utf8');

  const summary = buildSummary(manifest, turns, score, finalText, error);
  writeJson(join(runDir, 'summary.json'), summary);

  // Convenience copy of score stdout
  writeJson(join(runDir, 'score.json'), score.raw);

  return { runDir, manifest, summary, turns };
}

/** Default project root: package root (parent of src/ when running via tsx). */
export function defaultProjectRoot(): string {
  // src/eval/run.ts → repo root
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..');
}
