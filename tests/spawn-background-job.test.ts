import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import type { AgentStepEvent } from '../src/events.js';
import { getJobRegistry, resetJobRegistryForTests } from '../src/spawn/job-registry.js';
import {
  readJobEvents,
  readJobMeta,
  readJobResult,
} from '../src/spawn/job-store.js';
import { jobReportPath } from '../src/spawn/job-paths.js';
import { setSpawnRunnerForTests } from '../src/spawn/job-runner.js';
import type { RunSpawnOptions } from '../src/spawn/runner.js';
import type { AgentConfig } from '../src/types.js';
import { setWorkspaceRoot } from '../src/workspace.js';

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

const testPreset = {
  name: 'skeleton-reader',
  description: 'read-only code skeleton',
  systemPrompt: 'You are a reader.',
  tools: ['read_file', 'grep_search'],
  maxTurns: 4,
};

describe('spawn background jobs (Phase 1a)', () => {
  let tempDir = '';

  afterEach(() => {
    setSpawnRunnerForTests(null);
    resetJobRegistryForTests();
  });

  it('runs a job in background and writes meta, events, and result', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-spawn-job-'));
    setWorkspaceRoot(tempDir);

    const seenSpawnSessionIds: string[] = [];
    const seenSteps: AgentStepEvent[] = [];

    setSpawnRunnerForTests(async (opts: RunSpawnOptions) => {
      seenSpawnSessionIds.push(opts.spawnSessionId ?? '');
      opts.jobOnStep?.({ type: 'turn_start', turn: 1 });
      opts.jobOnStep?.({
        type: 'tool_call',
        turn: 1,
        call_id: 'call_1',
        name: 'read_file',
        args: '{"path":"src/foo.ts"}',
      });
      return 'Review complete: no issues found.';
    });

    const registry = getJobRegistry();
    const parentSessionId = 'session_job_parent_001';
    const handle = registry.start({
      preset: testPreset,
      task: 'Review src/foo.ts for bugs',
      parentConfig: minimalParentConfig(parentSessionId, tempDir),
    });

    assert.ok(handle.jobId.startsWith('job_'));
    assert.ok(existsSync(handle.metaPath));
    assert.ok(existsSync(handle.eventsPath));

    const result = await handle.promise;

    assert.equal(result.ok, true);
    assert.equal(result.status, 'completed');
    assert.ok(existsSync(handle.resultPath));

    const meta = readJobMeta(handle.jobId);
    assert.ok(meta);
    assert.equal(meta?.status, 'completed');
    assert.equal(meta?.parent_session_id, parentSessionId);
    assert.equal(meta?.preset, 'skeleton-reader');
    assert.match(meta?.spawn_session_id ?? '', /^spawn_/);

    const events = readJobEvents(handle.jobId);
    assert.ok(events.some((e) => e.t === 'spawn_start'));
    assert.ok(events.some((e) => e.t === 'turn_start'));
    assert.ok(events.some((e) => e.t === 'tool_call'));
    assert.ok(events.some((e) => e.t === 'spawn_end'));

    const resultFile = readJobResult(handle.jobId);
    assert.ok(resultFile);
    assert.equal(resultFile?.ok, true);
    assert.ok(resultFile?.summary_line.includes('Review complete'));
    assert.equal(resultFile?.duration_ms, result.durationMs);

    assert.equal(seenSpawnSessionIds.length, 1);
    assert.equal(seenSpawnSessionIds[0], meta?.spawn_session_id);
    assert.equal(seenSteps.length, 0);

    assert.ok(existsSync(jobReportPath(handle.jobId)));
    const report = readFileSync(jobReportPath(handle.jobId), 'utf8');
    assert.equal(report, 'Review complete: no issues found.');

    const listed = registry.list({ parentSessionId });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.job_id, handle.jobId);
  });

  it('marks job cancelled when abort fires before spawn resolves', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-spawn-job-cancel-'));
    setWorkspaceRoot(tempDir);

    let releaseSpawn: (() => void) | null = null;
    const spawnStarted = new Promise<void>((resolve) => {
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

    const registry = getJobRegistry();
    const handle = registry.start({
      preset: testPreset,
      task: 'Long review task',
      parentConfig: minimalParentConfig('session_job_cancel', tempDir),
    });

    await spawnStarted;
    assert.equal(registry.cancel(handle.jobId), 'aborted');

    const result = await handle.promise;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.ok, false);

    const meta = readJobMeta(handle.jobId);
    assert.equal(meta?.status, 'cancelled');
    assert.ok(readJobEvents(handle.jobId).some((e) => e.t === 'cancel'));
  });

  it('records failed status for spawn error text', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-spawn-job-fail-'));
    setWorkspaceRoot(tempDir);

    setSpawnRunnerForTests(async () => 'error: preset requires run_shell');

    const registry = getJobRegistry();
    const handle = registry.start({
      preset: testPreset,
      task: 'Will fail',
      parentConfig: minimalParentConfig('session_job_fail', tempDir),
    });

    const result = await handle.promise;
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');

    const meta = readJobMeta(handle.jobId);
    assert.equal(meta?.status, 'failed');
    const resultFile = readJobResult(handle.jobId);
    assert.equal(resultFile?.ok, false);
  });
});