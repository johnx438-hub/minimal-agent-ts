import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import { getJobRegistry, resetJobRegistryForTests } from '../src/spawn/job-registry.js';
import { setSpawnRunnerForTests } from '../src/spawn/job-runner.js';
import { readJobMeta } from '../src/spawn/job-store.js';
import {
  formatBackgroundReviewStarted,
  resolveRequestedReviewAgents,
  runCodeReviewTool,

  setGitDiffForTests,
  startBackgroundCodeReviewJobs,
  validateReviewAgents,
} from '../src/tools/code-review.js';
import type { AgentConfig } from '../src/types.js';
import { setWorkspaceRoot } from '../src/workspace.js';

const testPresets = [
  {
    name: 'code-review-bug',
    description: 'bug pass',
    systemPrompt: 'bug',
    tools: ['read_file', 'write_file'],
    maxTurns: 6,
  },
  {
    name: 'code-review-security',
    description: 'security pass',
    systemPrompt: 'security',
    tools: ['read_file', 'write_file'],
    maxTurns: 6,
  },
  {
    name: 'code-review-quality',
    description: 'quality pass',
    systemPrompt: 'quality',
    tools: ['read_file', 'write_file'],
    maxTurns: 6,
  },
];

const projectRoot = resolve(import.meta.dirname, '..');

function minimalConfig(): AgentConfig {
  return {
    apiKey: 'test',
    baseUrl: 'http://localhost',
    model: 'test-model',
    maxTurns: 8,
    cwd: projectRoot,
    allowShell: false,
    allowWeb: false,
    sessionId: 'session_code_review_bg',
  };
}

const sampleDiff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1,2 @@
+export const x = 1;
`;

describe('code_review background (Phase 1d)', () => {
  let tempDir = '';

  afterEach(() => {
    setGitDiffForTests(null);
    setSpawnRunnerForTests(null);
    resetJobRegistryForTests();
  });

  it('resolves focus labels to review presets', () => {
    assert.deepEqual(resolveRequestedReviewAgents(''), [
      'code-review-bug',
      'code-review-security',
      'code-review-quality',
    ]);
    assert.deepEqual(resolveRequestedReviewAgents('bug,security'), [
      'code-review-bug',
      'code-review-security',
    ]);
    assert.equal(validateReviewAgents(['nope']), 'error: invalid focus values: nope. Valid: bug, security, quality (or full preset names).');
  });

  it('returns immediately with three job ids when background=true', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-code-review-bg-'));
    setWorkspaceRoot(tempDir);

    let resolveSpawn: (() => void) | null = null;
    const spawnGate = new Promise<void>((resolve) => {
      resolveSpawn = resolve;
    });

    setGitDiffForTests(async () => sampleDiff);
    setSpawnRunnerForTests(async () => {
      await spawnGate;
      return '🔴 Found 1 bug.';
    });

    const startedAt = Date.now();
    const result = await runCodeReviewTool(
      'code_review',
      { scope: 'unstaged', background: true },
      minimalConfig(),
    );
    const elapsed = Date.now() - startedAt;

    assert.ok(result);
    assert.ok(result!.includes('code_review: started 3 background job(s)'));
    assert.ok(result!.includes('code-review-bug'));
    assert.ok(result!.includes('code-review-security'));
    assert.ok(result!.includes('code-review-quality'));
    assert.ok(result!.includes('npm run spawn:list'));
    assert.ok(result!.includes('workspace/code-review-bug.md'));
    assert.ok(elapsed < 300);

    const runningJobs = getJobRegistry().list({
      parentSessionId: 'session_code_review_bg',
      status: 'running',
    });
    assert.equal(runningJobs.length, 3);

    for (const meta of runningJobs) {
      const jobId = meta.job_id;
      assert.equal(meta.status, 'running');
      assert.ok(meta.output_paths.some((p) => p.startsWith('workspace/code-review-')));
      assert.ok(readJobMeta(jobId)?.job_id === jobId);
    }

    resolveSpawn?.();
  });

  it('starts only focused agents in background mode', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-code-review-focus-'));
    setWorkspaceRoot(tempDir);
    setGitDiffForTests(async () => sampleDiff);
    setSpawnRunnerForTests(async () => 'ok');

    const result = await runCodeReviewTool(
      'code_review',
      { scope: 'unstaged', focus: 'bug', background: true },
      minimalConfig(),
    );

    assert.ok(result);
    assert.match(result!, /started 1 background job/);
    assert.ok(result!.includes('code-review-bug'));
    assert.ok(!result!.includes('code-review-security'));
  });

  it('keeps synchronous Promise.all path when background=false', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-code-review-sync-'));
    setWorkspaceRoot(tempDir);
    setGitDiffForTests(async () => sampleDiff);

    let spawnCalls = 0;
    setSpawnRunnerForTests(async () => {
      spawnCalls++;
      return '🔴 Found 0 bugs.';
    });

    const result = await runCodeReviewTool(
      'code_review',
      { scope: 'unstaged' },
      minimalConfig(),
    );

    assert.ok(result);
    assert.ok(result!.startsWith('# Code Review: unstaged'));
    assert.equal(spawnCalls, 3);
  });

  it('formats background table with job paths', () => {
    const text = formatBackgroundReviewStarted('HEAD~2', [
      { agent: 'code-review-bug', jobId: 'job_test_001' },
      { agent: 'code-review-security', jobId: 'job_test_002' },
    ]);

    assert.ok(text.includes('scope: HEAD~2'));
    assert.ok(text.includes('job_test_001'));
    assert.ok(text.includes('workspace/jobs/job_test_001/meta.json'));
    assert.ok(text.includes('workspace/code-review-bug.md'));
  });

  it('startBackgroundCodeReviewJobs wires report output hints', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-code-review-hints-'));
    setWorkspaceRoot(tempDir);

    const jobs = startBackgroundCodeReviewJobs({
      reviewPresets: [testPresets[0]!],
      diffMessage: 'review this',
      config: minimalConfig(),
    });

    assert.equal(jobs.length, 1);
    const meta = readJobMeta(jobs[0]!.jobId);
    assert.deepEqual(meta?.output_paths, ['workspace/code-review-bug.md']);
    assert.ok(existsSync(join(tempDir, 'workspace')));
  });
});