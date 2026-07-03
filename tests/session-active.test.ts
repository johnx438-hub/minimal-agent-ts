import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createSession,
  getLatestSession,
  listSessions,
  loadSession,
  saveSession,
  sessionActiveAt,
} from '../src/session.js';
import { setWorkspaceRoot } from '../src/workspace.js';

describe('sessionActiveAt', () => {
  it('prefers updated_at over created_at', () => {
    assert.equal(
      sessionActiveAt({ created_at: 100, updated_at: 500 }, 900),
      500,
    );
  });

  it('falls back to file mtime then created_at', () => {
    assert.equal(sessionActiveAt({ created_at: 100 }, 400), 400);
    assert.equal(sessionActiveAt({ created_at: 100 }), 100);
  });
});

describe('listSessions active ordering', () => {
  it('sorts by updated_at so resume-last picks recently active session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-sess-active-'));
    setWorkspaceRoot(dir);

    const older = createSession('user_default');
    const olderTick = older.session_id.slice('session_'.length);
    while (
      new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14) === olderTick
    ) {
      /* session ids are second-granularity; avoid overwriting the same file */
    }
    const newer = createSession('user_default');
    assert.notEqual(older.session_id, newer.session_id);

    const olderPath = join(dir, '.sessions', `${older.session_id}.json`);
    const newerPath = join(dir, '.sessions', `${newer.session_id}.json`);

    utimesSync(olderPath, new Date('2020-01-01'), new Date('2020-01-01'));

    const newerUpdated =
      (JSON.parse(readFileSync(newerPath, 'utf8')) as { updated_at?: number })
        .updated_at ?? 0;
    while (Date.now() <= newerUpdated) {
      /* saveSession must advance past the newer session's updated_at */
    }

    const reloaded = loadSession(older.session_id);
    assert.ok(reloaded);
    saveSession(reloaded!);

    const listed = listSessions('user_default');
    assert.equal(listed[0]?.session_id, older.session_id);
    assert.equal(getLatestSession('user_default')?.session_id, older.session_id);

    const olderOnDisk = JSON.parse(readFileSync(olderPath, 'utf8')) as {
      updated_at?: number;
    };
    const newerOnDisk = JSON.parse(readFileSync(newerPath, 'utf8')) as {
      updated_at?: number;
    };
    assert.ok((olderOnDisk.updated_at ?? 0) >= (newerOnDisk.updated_at ?? 0));
  });

  it('uses file mtime for legacy sessions without updated_at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-sess-legacy-'));
    setWorkspaceRoot(dir);

    const legacyId = 'session_20200101120000';
    const recentId = 'session_20250101120000';
    const sessionsRoot = join(dir, '.sessions');
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, `${legacyId}.json`),
      JSON.stringify(
        {
          session_id: legacyId,
          user_id: 'user_default',
          created_at: Date.parse('2020-01-01T12:00:00Z'),
          tasks: [],
          current_messages: [],
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      join(sessionsRoot, `${recentId}.json`),
      JSON.stringify(
        {
          session_id: recentId,
          user_id: 'user_default',
          created_at: Date.parse('2025-01-01T12:00:00Z'),
          tasks: [],
          current_messages: [],
        },
        null,
        2,
      ),
      'utf8',
    );

    const legacyPath = join(sessionsRoot, `${legacyId}.json`);
    const recentPath = join(sessionsRoot, `${recentId}.json`);
    utimesSync(legacyPath, new Date(), new Date());
    utimesSync(recentPath, new Date('2020-06-01'), new Date('2020-06-01'));

    const latest = getLatestSession('user_default');
    assert.equal(latest?.session_id, legacyId);
  });
});