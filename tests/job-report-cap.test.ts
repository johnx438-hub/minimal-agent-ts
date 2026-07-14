import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  buildInitialMeta,
  clampJobReportContent,
  MAX_JOB_REPORT_BYTES,
  readJobMeta,
  writeJobMeta,
  writeJobReport,
} from '../src/spawn/job-store.js';
import { tryParseJobReportPath } from '../src/spawn/job-paths.js';
import { getWorkspaceRoot, setWorkspaceRoot } from '../src/workspace.js';

describe('job report size cap', () => {
  let prev: string;
  let dir: string;

  before(() => {
    prev = getWorkspaceRoot();
    dir = mkdtempSync(join(tmpdir(), 'job-report-cap-'));
    setWorkspaceRoot(dir);
  });

  after(() => {
    setWorkspaceRoot(prev);
    rmSync(dir, { recursive: true, force: true });
  });

  it('clampJobReportContent leaves small reports alone', () => {
    const c = clampJobReportContent('hello report');
    assert.equal(c.truncated, false);
    assert.equal(c.content, 'hello report');
  });

  it('clampJobReportContent truncates oversize content with footer', () => {
    // Use a tiny override simulation: content larger than cap via real clamp
    // We can't change the constant; generate content just over a mock by testing
    // structure with a medium string and checking helper with forced large buffer.
    const big = 'x'.repeat(MAX_JOB_REPORT_BYTES + 5000);
    const c = clampJobReportContent(big);
    assert.equal(c.truncated, true);
    assert.ok(c.written_bytes <= MAX_JOB_REPORT_BYTES);
    assert.match(c.content, /\[report_truncated\]/);
    assert.match(c.content, /original_bytes=/);
  });

  it('writeJobReport records meta when job exists', () => {
    const jobId = 'job_test_report_cap_001';
    writeJobMeta(
      buildInitialMeta({
        jobId,
        parentSessionId: 'session_test',
        spawnSessionId: 'spawn_x',
        preset: 'dev-worker',
        task: 't',
        cwd: dir,
        status: 'running',
      }),
    );
    const big = 'y'.repeat(MAX_JOB_REPORT_BYTES + 1000);
    const result = writeJobReport(jobId, big);
    assert.equal(result.truncated, true);
    const meta = readJobMeta(jobId);
    assert.equal(meta?.report_truncated, true);
    assert.ok((meta?.report_bytes ?? 0) <= MAX_JOB_REPORT_BYTES);
    const onDisk = readFileSync(
      join(dir, 'workspace', 'jobs', jobId, 'report.md'),
      'utf8',
    );
    assert.match(onDisk, /report_truncated/);
  });

  it('tryParseJobReportPath matches workspace job reports', () => {
    const abs = join(dir, 'workspace', 'jobs', 'job_abc_1', 'report.md');
    assert.equal(tryParseJobReportPath(dir, abs), 'job_abc_1');
    assert.equal(tryParseJobReportPath(dir, join(dir, 'other.md')), null);
  });
});
