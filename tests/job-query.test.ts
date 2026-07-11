import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { getJobRegistry, resetJobRegistryForTests } from '../src/spawn/job-registry.js';
import { setSpawnRunnerForTests } from '../src/spawn/job-runner.js';
import type { RunSpawnOptions } from '../src/spawn/runner.js';
import {
  countRunningJobs,
  formatJobEventsTail,
  formatJobList,
  formatJobStatus,
  getJobStatusDetail,
  isStaleJob,
  listSpawnJobs,
  toJobListEntry,
} from '../src/spawn/job-query.js';
import { appendJobEvent } from '../src/spawn/job-store.js';
import { setWorkspaceRoot } from '../src/workspace.js';

describe('job-query', () => {
  let root: string;

  afterEach(() => {
    setSpawnRunnerForTests(null);
    resetJobRegistryForTests();
  });

  it('lists jobs and formats status', async () => {
    root = mkdtempSync(join(tmpdir(), 'job-query-'));
    setWorkspaceRoot(root);

    setSpawnRunnerForTests(async (_opts: RunSpawnOptions) => {
      await new Promise((r) => setTimeout(r, 500));
      return 'ok';
    });

    const registry = getJobRegistry();
    const handle = registry.start({
      preset: {
        name: 'demo-preset',
        description: 'demo',
        systemPrompt: 'You are a demo agent.',
        tools: ['read_file'],
        maxTurns: 3,
      },
      task: 'inspect README',
      parentConfig: {
        apiKey: 'k',
        baseUrl: 'https://example.com',
        model: 'test',
        maxTurns: 5,
        cwd: root,
        allowShell: false,
        allowWeb: false,
        sessionId: 'parent_sess',
      },
    });

    const jobs = listSpawnJobs({ limit: 5 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.job_id, handle.jobId);
    assert.equal(jobs[0]!.preset, 'demo-preset');

    const entry = toJobListEntry(jobs[0]!);
    assert.equal(entry.job_id, handle.jobId);
    assert.equal(entry.stale, false);

    appendJobEvent(handle.jobId, { t: 'step', turn: 1 });

    const detail = getJobStatusDetail(handle.jobId, 3);
    assert.ok(detail);
    assert.ok(detail!.event_total >= 1);
    assert.ok(detail!.events_tail.some((e) => e.t === 'step'));

    const statusText = formatJobStatus(handle.jobId, 3);
    assert.ok(statusText?.includes('--- meta ---'));
    assert.ok(statusText?.includes(handle.jobId));

    const tailText = formatJobEventsTail(handle.jobId);
    assert.ok(tailText?.includes('"t":"step"'));

    const listText = formatJobList({ limit: 5 });
    assert.ok(listText.includes('JOB_ID'));
    assert.ok(listText.includes(handle.jobId));

    assert.equal(countRunningJobs(jobs), 1);
  });

  it('marks stale running jobs', () => {
    const staleMeta = {
      v: 1 as const,
      job_id: 'job_stale_test',
      parent_session_id: 'sess',
      spawn_session_id: 'spawn_sess',
      preset: 'demo',
      task_preview: 'task',
      cwd: '/tmp',
      status: 'running' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      output_paths: [],
      pid: 0,
    };
    assert.equal(isStaleJob(staleMeta), true);
    assert.equal(isStaleJob({ ...staleMeta, status: 'completed' }), false);
  });
});