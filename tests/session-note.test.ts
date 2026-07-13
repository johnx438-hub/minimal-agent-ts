import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  createSession,
  listSessions,
  loadSession,
  setSessionNote,
} from '../src/session.js';
import { getWorkspaceRoot, setWorkspaceRoot } from '../src/workspace.js';

describe('setSessionNote', () => {
  let prevRoot: string;
  let dir: string;

  before(() => {
    prevRoot = getWorkspaceRoot();
    dir = mkdtempSync(join(tmpdir(), 'sess-note-'));
    setWorkspaceRoot(dir);
  });

  after(() => {
    setWorkspaceRoot(prevRoot);
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists and clears notes on disk', () => {
    const session = createSession('user_default');
    assert.equal(setSessionNote(session.session_id, '  C5 shell  '), true);
    const loaded = loadSession(session.session_id);
    assert.equal(loaded?.note, 'C5 shell');

    const listed = listSessions('user_default');
    const meta = listed.find((s) => s.session_id === session.session_id);
    assert.equal(meta?.note, 'C5 shell');

    assert.equal(setSessionNote(session.session_id, '   '), true);
    const cleared = loadSession(session.session_id);
    assert.equal(cleared?.note, undefined);
  });

  it('returns false for missing session', () => {
    assert.equal(setSessionNote('session_does_not_exist', 'x'), false);
  });
});
