import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach } from 'node:test';

import {
  formatImportResult,
  importProjectLocalSessions,
} from '../src/session-import.js';
import { projectIdFromRoot, resetWorkspaceForTests } from '../src/workspace.js';
import type { SessionFile } from '../src/types.js';

describe('importProjectLocalSessions (SW-6)', () => {
  beforeEach(() => {
    resetWorkspaceForTests();
  });

  it('copies session json and sidecars into agent_home by-project bucket', () => {
    const project = mkdtempSync(join(tmpdir(), 'imp-proj-'));
    const home = mkdtempSync(join(tmpdir(), 'imp-home-'));
    const src = join(project, '.sessions');
    mkdirSync(src, { recursive: true });

    const session: SessionFile = {
      session_id: 'session_20260101000000',
      user_id: 'u',
      created_at: 1,
      updated_at: 2,
      tasks: [],
      current_messages: [{ role: 'user', content: 'hello' }],
    };
    writeFileSync(
      join(src, 'session_20260101000000.json'),
      JSON.stringify(session),
    );
    writeFileSync(
      join(src, 'transcript_session_20260101000000.jsonl'),
      '{}\n',
    );
    writeFileSync(join(src, 'handoff_session_20260101000000.md'), '# h\n');
    mkdirSync(join(src, 'spawn', 'session_20260101000000'), { recursive: true });
    writeFileSync(
      join(src, 'spawn', 'session_20260101000000', 'runs.jsonl'),
      '{}\n',
    );

    const r = importProjectLocalSessions({
      projectRoot: project,
      agentHome: home,
    });

    assert.equal(r.imported.length, 1);
    assert.equal(r.skipped.length, 0);
    assert.equal(r.errors.length, 0);
    assert.ok(r.sidecars >= 2);

    const pid = projectIdFromRoot(project);
    const destJson = join(
      home,
      'sessions',
      'by-project',
      pid,
      'session_20260101000000.json',
    );
    assert.ok(existsSync(destJson));
    const loaded = JSON.parse(readFileSync(destJson, 'utf8')) as SessionFile;
    assert.equal(loaded.workspace?.project_id, pid);
    assert.equal(loaded.workspace?.primary_root, project);
    assert.ok(
      existsSync(
        join(
          home,
          'sessions',
          'by-project',
          pid,
          'transcript_session_20260101000000.jsonl',
        ),
      ),
    );
    assert.match(formatImportResult(r), /imported: 1/);
  });

  it('skips existing without overwrite', () => {
    const project = mkdtempSync(join(tmpdir(), 'imp-proj2-'));
    const home = mkdtempSync(join(tmpdir(), 'imp-home2-'));
    const src = join(project, '.sessions');
    mkdirSync(src, { recursive: true });
    const session: SessionFile = {
      session_id: 'session_20260101000001',
      user_id: 'u',
      created_at: 1,
      tasks: [],
      current_messages: [],
    };
    writeFileSync(
      join(src, 'session_20260101000001.json'),
      JSON.stringify(session),
    );

    const r1 = importProjectLocalSessions({
      projectRoot: project,
      agentHome: home,
    });
    assert.equal(r1.imported.length, 1);

    const r2 = importProjectLocalSessions({
      projectRoot: project,
      agentHome: home,
    });
    assert.equal(r2.imported.length, 0);
    assert.equal(r2.skipped.length, 1);

    const r3 = importProjectLocalSessions({
      projectRoot: project,
      agentHome: home,
      overwrite: true,
    });
    assert.equal(r3.imported.length, 1);
  });

  it('reports missing source dir', () => {
    const project = mkdtempSync(join(tmpdir(), 'imp-empty-'));
    const home = mkdtempSync(join(tmpdir(), 'imp-home3-'));
    const r = importProjectLocalSessions({
      projectRoot: project,
      agentHome: home,
    });
    assert.equal(r.imported.length, 0);
    assert.ok(r.errors.some((e) => /not found/.test(e.error)));
  });
});
