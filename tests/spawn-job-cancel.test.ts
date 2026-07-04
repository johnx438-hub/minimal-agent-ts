import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import {
  isCancelRequested,
  pollJobCancel,
  writeCancelRequested,
} from '../src/spawn/job-cancel.js';
import { jobCancelRequestedPath } from '../src/spawn/job-paths.js';
import {
  getJobRegistry,
  releaseJobHandleForTests,
  resetJobRegistryForTests,
} from '../src/spawn/job-registry.js';
import { setSpawnRunnerForTests } from '../src/spawn/job-runner.js';
import { readJobMeta } from '../src/spawn/job-store.js';
import { killSpawnJob } from '../src/spawn/job-cli.js';
import type { RunSpawnOptions } from '../src/spawn/runner.js';
import { runSpawnBackgroundTool } from '../src/tools/spawn-background.js';
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

describe('spawn job cancel.requested (Phase 1c)', () => {
  let tempDir = '';

  afterEach(() => {
    setSpawnRunnerForTests(null);
    resetJobRegistryForTests();
  });

  it('pollJobCancel aborts when cancel.requested exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-spawn-cancel-poll-'));
    setWorkspaceRoot(tempDir);

    const jobId = 'job_test_poll_001';
    writeCancelRequested(jobId, 'test');

    const controller = new AbortController();
    assert.equal(pollJobCancel(jobId, controller), true);
    assert.equal(controller.signal.aborted, true);
  });

  it('cross-process kill writes cancel.requested without immediate meta cancel', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-spawn-cancel-xproc-'));
    setWorkspaceRoot(tempDir);

    let releaseSpawn: (() => void) | null = null;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    let resolveStepGate: (() => void) | null = null;
    const stepGate = new Promise<void>((resolve) => {
      resolveStepGate = resolve;
    });

    setSpawnRunnerForTests(async (opts: RunSpawnOptions) => {
      releaseSpawn?.();
      await stepGate;
      opts.jobOnStep?.({ type: 'turn_start', turn: 1 });
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
      task: 'cross-process cancel',
      parentConfig: minimalParentConfig('session_cancel_xproc', tempDir),
    });

    await spawnGate;

    releaseJobHandleForTests(handle.jobId);

    const outcome = registry.cancel(handle.jobId);
    assert.equal(outcome, 'requested');
    assert.ok(existsSync(jobCancelRequestedPath(handle.jobId)));
    assert.equal(isCancelRequested(handle.jobId), true);

    const metaWhileRunning = readJobMeta(handle.jobId);
    assert.equal(metaWhileRunning?.status, 'running');

    resolveStepGate?.();

    const result = await handle.promise;
    assert.equal(result.status, 'cancelled');
    assert.equal(readJobMeta(handle.jobId)?.status, 'cancelled');
    assert.equal(isCancelRequested(handle.jobId), false);
  });

  it('killSpawnJob reports cancel requested for detached jobs', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-spawn-cancel-cli-'));
    setWorkspaceRoot(tempDir);

    let releaseSpawn: (() => void) | null = null;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    let resolveStepGate: (() => void) | null = null;
    const stepGate = new Promise<void>((resolve) => {
      resolveStepGate = resolve;
    });

    setSpawnRunnerForTests(async (opts: RunSpawnOptions) => {
      releaseSpawn?.();
      await stepGate;
      opts.jobOnStep?.({ type: 'turn_start', turn: 1 });
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
      { preset: 'skeleton-reader', task: 'cli cross kill' },
      minimalParentConfig('session_cancel_cli', tempDir),
      [testPreset],
    );
    const jobId = started!.match(/started (job_[^\s]+)/)?.[1];
    assert.ok(jobId);

    const registry = getJobRegistry();
    const handle = registry.getHandle(jobId!);
    assert.ok(handle);

    await spawnGate;
    releaseJobHandleForTests(jobId!);

    const kill = killSpawnJob(jobId!);
    assert.equal(kill.ok, true);
    assert.match(kill.message, /cancel requested/);
    assert.ok(existsSync(jobCancelRequestedPath(jobId!)));

    resolveStepGate?.();

    const record = JSON.parse(readFileSync(jobCancelRequestedPath(jobId!), 'utf8')) as {
      job_id: string;
      source: string;
    };
    assert.equal(record.job_id, jobId);
    assert.equal(record.source, 'registry_miss');

    const result = await handle!.promise;
    assert.equal(result.status, 'cancelled');
  });
});