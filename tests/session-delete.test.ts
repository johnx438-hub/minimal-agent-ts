import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildActionBlock, saveAction } from '../src/action-store.js';
import {
  collectSessionArtifacts,
  deleteSession,
  formatSessionDeleteSummary,
  rewriteJobIndexForSessionDelete,
} from '../src/session-delete.js';
import { createSession, loadSession, saveSession } from '../src/session.js';
import {
  appendJobIndex,
  buildInitialMeta,
  readJobIndex,
  writeJobMeta,
} from '../src/spawn/job-store.js';
import { configureActionWriteQueue, flushActionWrites } from '../src/action-write-queue.js';
import { getWorkspaceRoot, setWorkspaceRoot } from '../src/workspace.js';
import { handoffPath, sessionPath, spawnActionsDir, spawnRunsDir, transcriptPath } from '../src/workspace.js';
import { jobDir, jobsIndexPath } from '../src/spawn/job-paths.js';

describe('session delete', () => {
  let prevRoot: string;
  let dir: string;

  before(() => {
    prevRoot = getWorkspaceRoot();
    dir = mkdtempSync(join(tmpdir(), 'sess-del-'));
    setWorkspaceRoot(dir);
    configureActionWriteQueue({ sync: true });
  });

  after(() => {
    setWorkspaceRoot(prevRoot);
    rmSync(dir, { recursive: true, force: true });
  });

  it('collectSessionArtifacts counts bound files', () => {
    const session = createSession('user_default');
    const sid = session.session_id;
    session.tasks.push({
      task_id: 'task_x_001',
      session_id: sid,
      turn_range: [1, 2],
      action_count: 1,
      user_intent: 'do thing',
      user_messages: ['do thing'],
      files_touched: ['a.ts'],
      tech_concepts: [],
      tools_used: ['read_file'],
      pending_tasks: [],
      current_work: 'worked on a',
    });
    saveSession(session);

    writeFileSync(handoffPath(sid), '# handoff\n', 'utf8');
    writeFileSync(transcriptPath(sid), '{"t":1}\n', 'utf8');

    const block = buildActionBlock({
      action_id: 'action_test_001',
      task_id: 'task_x_001',
      session_id: sid,
      turn_number: 1,
      tool_name: 'read_file',
      args_json: '{"path":"a.ts"}',
      result_text: 'hello',
    });
    saveAction(block);
    flushActionWrites();

    mkdirSync(spawnActionsDir(sid), { recursive: true });
    writeFileSync(
      join(spawnActionsDir(sid), 'action_spawn_001.json'),
      JSON.stringify({ session_id: 'spawn_child', action_id: 'action_spawn_001' }),
      'utf8',
    );
    mkdirSync(spawnRunsDir(sid), { recursive: true });
    writeFileSync(join(spawnRunsDir(sid), 'runs.jsonl'), '{}\n', 'utf8');

    const jobId = 'job_test_del_001';
    writeJobMeta(
      buildInitialMeta({
        jobId,
        parentSessionId: sid,
        spawnSessionId: 'spawn_x',
        preset: 'dev-worker',
        task: 'test',
        cwd: dir,
        status: 'completed',
      }),
    );
    appendJobIndex({
      job_id: jobId,
      parent_session_id: sid,
      preset: 'dev-worker',
      status: 'completed',
      created_at: new Date().toISOString(),
    });

    const art = collectSessionArtifacts(sid);
    assert.equal(art.exists, true);
    assert.equal(art.task_count, 1);
    assert.ok(art.flat_action_ids.includes('action_test_001'));
    assert.equal(art.handoff_exists, true);
    assert.equal(art.transcript_exists, true);
    assert.equal(art.spawn_actions_exists, true);
    assert.ok(art.spawn_actions_files >= 1);
    assert.equal(art.jobs.length, 1);
    assert.equal(art.jobs[0]?.job_id, jobId);
    assert.match(formatSessionDeleteSummary(art), /Delete /);
    assert.match(formatSessionDeleteSummary(art), /jobs: 1/);
  });

  it('deleteSession removes disk artifacts and rewrites job index', () => {
    const session = createSession('user_default');
    const sid = session.session_id;
    saveSession(session);

    const block = buildActionBlock({
      action_id: 'action_del_me_001',
      task_id: 'task_y_001',
      session_id: sid,
      turn_number: 1,
      tool_name: 'grep_search',
      args_json: '{}',
      result_text: 'x',
    });
    saveAction(block);
    flushActionWrites();

    // Unrelated action must survive
    const other = buildActionBlock({
      action_id: 'action_other_999',
      task_id: 'task_z_001',
      session_id: 'session_other_keep',
      turn_number: 1,
      tool_name: 'read_file',
      args_json: '{}',
      result_text: 'keep',
    });
    saveAction(other);
    flushActionWrites();

    writeFileSync(handoffPath(sid), 'h', 'utf8');
    writeFileSync(transcriptPath(sid), 't\n', 'utf8');
    mkdirSync(spawnActionsDir(sid), { recursive: true });
    writeFileSync(join(spawnActionsDir(sid), 'a.json'), '{}', 'utf8');
    mkdirSync(spawnRunsDir(sid), { recursive: true });
    writeFileSync(join(spawnRunsDir(sid), 'runs.jsonl'), '{}\n', 'utf8');

    const jobId = 'job_test_del_002';
    writeJobMeta(
      buildInitialMeta({
        jobId,
        parentSessionId: sid,
        spawnSessionId: 'spawn_y',
        preset: 'skeleton-reader',
        task: 'map',
        cwd: dir,
        status: 'completed',
      }),
    );
    appendJobIndex({
      job_id: jobId,
      parent_session_id: sid,
      preset: 'skeleton-reader',
      status: 'completed',
      created_at: new Date().toISOString(),
    });
    appendJobIndex({
      job_id: 'job_keep_other',
      parent_session_id: 'session_other_keep',
      preset: 'dev-worker',
      status: 'completed',
      created_at: new Date().toISOString(),
    });

    const result = deleteSession(sid, { cancelJob: () => false });
    assert.equal(result.ok, true);
    assert.equal(existsSync(sessionPath(sid)), false);
    assert.equal(existsSync(handoffPath(sid)), false);
    assert.equal(existsSync(transcriptPath(sid)), false);
    assert.equal(existsSync(spawnActionsDir(sid)), false);
    assert.equal(existsSync(spawnRunsDir(sid)), false);
    assert.equal(existsSync(jobDir(jobId)), false);
    assert.equal(loadSession(sid), null);

    // other session action kept
    assert.equal(
      existsSync(join(dir, '.sessions', 'actions', 'action_other_999.json')),
      true,
    );

    const index = readJobIndex();
    assert.ok(!index.some((e) => e.parent_session_id === sid));
    assert.ok(index.some((e) => e.job_id === 'job_keep_other'));
  });

  it('rejects spawn_ session ids', () => {
    const r = deleteSession('spawn_abc_1');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /invalid/i);
  });

  it('rewriteJobIndexForSessionDelete is idempotent when nothing matches', () => {
    const before = readJobIndex().length;
    const removed = rewriteJobIndexForSessionDelete('session_never_existed', []);
    assert.equal(removed, 0);
    assert.equal(readJobIndex().length, before);
  });
});
