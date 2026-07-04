import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import { getJobRegistry, resetJobRegistryForTests } from '../src/spawn/job-registry.js';
import { setSpawnRunnerForTests } from '../src/spawn/job-runner.js';
import { readJobMeta } from '../src/spawn/job-store.js';
import {
  formatJobList,
  formatJobStatus,
  killSpawnJob,
} from '../src/spawn/job-cli.js';
import type { RunSpawnOptions } from '../src/spawn/runner.js';
import {
  runSpawnBackgroundTool,
} from '../src/tools/spawn-background.js';
import type { AgentConfig } from '../src/types.js';
import { setWorkspaceRoot } from '../src/workspace.js';

const testPreset = {
  name: 'skeleton-reader',
  description: 'read-only code skeleton',
  systemPrompt: 'You are a reader.',
  tools: ['read_file', 'grep_search'],
  maxTurns: 4,
};

function minimalParentConfig(sessionId: string, cwd: string): AgentConfig {
  return {
    apiKey: 'test',
    baseUrl: 'http://localhost',
    model: 'test-model',
    maxTurns: 8,
    cwd,
    allowShell: false,
    allowWeb: false,
    sessionId,
  };
}

describe('spawn_background tool (Phase 1b)', () => {
  let tempDir = '';

  afterEach(() => {
    setSpawnRunnerForTests(null);
    resetJobRegistryForTests();
  });

  it('returns immediately with job paths without waiting', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-spawn-bg-tool-'));
    setWorkspaceRoot(tempDir);

    let resolveSpawn: (() => void) | null = null;
    const spawnGate = new Promise<void>((resolve) => {
      resolveSpawn = resolve;
    });

    setSpawnRunnerForTests(async () => {
      await spawnGate;
      return 'done';
    });

    const startedAt = Date.now();
    const result = await runSpawnBackgroundTool(
      'spawn_background',
      { preset: 'skeleton-reader', task: 'Review foo.ts' },
      minimalParentConfig('session_bg_tool', tempDir),
      [testPreset],
    );
    const elapsed = Date.now() - startedAt;

    assert.ok(result);
    assert.ok(result!.includes('spawn_background: started job_'));
    assert.ok(result!.includes('status: workspace/jobs/job_'));
    assert.ok(result!.includes('events: workspace/jobs/job_'));
    assert.ok(result!.includes('npm run spawn:status'));
    assert.ok(elapsed < 200);

    const jobId = result!.match(/started (job_[^\s]+)/)?.[1];
    assert.ok(jobId);

    resolveSpawn?.();
    const meta = readJobMeta(jobId!);
    assert.ok(meta);
    assert.equal(meta?.preset, 'skeleton-reader');
  });

  it('supports wait=true and returns result summary', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-spawn-bg-wait-'));
    setWorkspaceRoot(tempDir);

    setSpawnRunnerForTests(async (opts: RunSpawnOptions) => {
      opts.jobOnStep?.({ type: 'turn_start', turn: 1 });
      return 'Background review: all clear.';
    });

    const result = await runSpawnBackgroundTool(
      'spawn_background',
      { preset: 'skeleton-reader', task: 'Review bar.ts', wait: true },
      minimalParentConfig('session_bg_wait', tempDir),
      [testPreset],
    );

    assert.ok(result);
    assert.match(result!, /spawn_background: completed job_/);
    assert.ok(result!.includes('ok: true'));
    assert.ok(result!.includes('Background review'));
    assert.ok(result!.includes('result: workspace/jobs/job_'));
  });

  it('applies output_hint to meta output_paths', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-spawn-bg-hint-'));
    setWorkspaceRoot(tempDir);

    setSpawnRunnerForTests(async () => 'short');

    const result = await runSpawnBackgroundTool(
      'spawn_background',
      {
        preset: 'skeleton-reader',
        task: 'x',
        output_hint: 'workspace/custom-report.md',
        wait: true,
      },
      minimalParentConfig('session_bg_hint', tempDir),
      [testPreset],
    );

    assert.ok(result);
    const jobId = result!.match(/job_[a-z0-9_]+/i)?.[0];
    assert.ok(jobId);
    const meta = readJobMeta(jobId!);
    assert.ok(meta?.output_paths.includes('workspace/custom-report.md'));
  });
});

describe('spawn job CLI (Phase 1b)', () => {
  let tempDir = '';

  afterEach(() => {
    setSpawnRunnerForTests(null);
    resetJobRegistryForTests();
  });

  it('lists jobs and formats status from disk', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-spawn-cli-'));
    setWorkspaceRoot(tempDir);

    setSpawnRunnerForTests(async (opts: RunSpawnOptions) => {
      opts.jobOnStep?.({ type: 'turn_start', turn: 1 });
      opts.jobOnStep?.({
        type: 'tool_call',
        turn: 1,
        call_id: 'c1',
        name: 'read_file',
        args: '{"path":"a.ts"}',
      });
      return 'CLI test done.';
    });

    const toolResult = await runSpawnBackgroundTool(
      'spawn_background',
      { preset: 'skeleton-reader', task: 'CLI visibility test', wait: true },
      minimalParentConfig('session_cli', tempDir),
      [testPreset],
    );
    assert.ok(toolResult);

    const jobId = toolResult!.match(/job_[a-z0-9_]+/i)?.[0];
    assert.ok(jobId);

    const listText = formatJobList({ limit: 10 });
    assert.ok(listText.includes(jobId!));
    assert.ok(listText.includes('completed'));
    assert.ok(listText.includes('skeleton-reader'));

    const statusText = formatJobStatus(jobId!);
    assert.ok(statusText);
    assert.ok(statusText!.includes('"status": "completed"'));
    assert.ok(statusText!.includes('turn_start'));
    assert.ok(statusText!.includes('CLI test done'));
  });

  it('kills a running job via CLI helper', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-spawn-cli-kill-'));
    setWorkspaceRoot(tempDir);

    let releaseSpawn: (() => void) | null = null;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });

    setSpawnRunnerForTests(async (opts: RunSpawnOptions) => {
      releaseSpawn?.();
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (opts.parentConfig.abortSignal?.aborted) {
            clearInterval(timer);
            resolve();
          }
        }, 5);
      });
      return '[aborted]';
    });

    const started = await runSpawnBackgroundTool(
      'spawn_background',
      { preset: 'skeleton-reader', task: 'kill me' },
      minimalParentConfig('session_cli_kill', tempDir),
      [testPreset],
    );
    const jobId = started!.match(/started (job_[^\s]+)/)?.[1];
    assert.ok(jobId);

    await spawnGate;

    const handle = getJobRegistry().getHandle(jobId!);
    assert.ok(handle);

    const kill = killSpawnJob(jobId!);
    assert.equal(kill.ok, true);
    assert.match(kill.message, /cancelled/);

    const result = await handle!.promise;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.ok, false);

    const statusText = formatJobStatus(jobId!);
    assert.ok(statusText?.includes('"status": "cancelled"'));
    assert.ok(statusText?.includes('"ok": false'));
  });
});