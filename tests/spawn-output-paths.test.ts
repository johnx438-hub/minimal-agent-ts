import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ensureSpawnOutputPaths } from '../src/spawn/ensure-output-paths.js';
import { getJobRegistry, resetJobRegistryForTests } from '../src/spawn/job-registry.js';
import { setSpawnRunnerForTests } from '../src/spawn/job-runner.js';
import { readJobMeta } from '../src/spawn/job-store.js';
import type { AgentConfig } from '../src/types.js';
import { setWorkspaceRoot } from '../src/workspace.js';
import type { ResolvedSpawnPreset } from '../src/spawn/types.js';

const testPreset: ResolvedSpawnPreset = {
  name: 'skeleton-reader',
  description: 'test',
  systemPrompt: 'test',
  tools: ['read_file'],
  maxTurns: 5,
};

function minimalConfig(sessionId: string, cwd: string): AgentConfig {
  return {
    cwd,
    apiKey: 'test',
    baseUrl: 'http://localhost',
    model: 'test',
    allowShell: false,
    allowWeb: true,
    sessionId,
  };
}

describe('ensureSpawnOutputPaths', () => {
  it('creates parent directories for workspace report hints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-out-paths-'));
    ensureSpawnOutputPaths(dir, ['workspace/reports/custom.md']);
    assert.ok(existsSync(join(dir, 'workspace', 'reports')));
  });

  it('ignores invalid escape paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-out-paths-bad-'));
    assert.doesNotThrow(() => ensureSpawnOutputPaths(dir, ['../outside/report.md']));
    assert.equal(existsSync(join(dir, '..', 'outside')), false);
  });
});

describe('spawn job output_paths', () => {
  let tempDir = '';

  afterEach(() => {
    setSpawnRunnerForTests(null);
    resetJobRegistryForTests();
  });

  it('creates hinted output directories when a background job starts', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-job-out-paths-'));
    setWorkspaceRoot(tempDir);
    setSpawnRunnerForTests(async () => 'done');

    const handle = getJobRegistry().start({
      preset: testPreset,
      task: 'write report',
      parentConfig: minimalConfig('session_out_paths', tempDir),
      outputPaths: ['workspace/jobs/custom/report.md'],
    });

    assert.ok(existsSync(join(tempDir, 'workspace', 'jobs', 'custom')));
    const meta = readJobMeta(handle.jobId);
    assert.deepEqual(meta?.output_paths, ['workspace/jobs/custom/report.md']);
  });
});