import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach } from 'node:test';

import { createSession, loadSession, saveSession } from '../src/session.js';
import {
  resolveReadablePath,
  resolveWritablePath,
} from '../src/tools/path-utils.js';
import type { AgentConfig } from '../src/types.js';
import {
  addWorkspaceGrant,
  configureSessionStore,
  getProjectId,
  getSessionStoreMode,
  getWorkspaceRoot,
  projectIdFromRoot,
  resetWorkspaceForTests,
  sessionsDir,
  sessionPath,
  setWorkspaceRoot,
} from '../src/workspace.js';

function minimalConfig(cwd: string): AgentConfig {
  return {
    apiKey: 't',
    baseUrl: 'http://x',
    model: 'm',
    maxTurns: 0,
    cwd,
    allowShell: false,
    allowWeb: false,
  };
}

describe('session workspace store', () => {
  beforeEach(() => {
    resetWorkspaceForTests();
  });

  it('project_local keeps sessions under cwd/.sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sw-local-'));
    configureSessionStore({ mode: 'project_local', cwd: dir });
    assert.equal(getSessionStoreMode(), 'project_local');
    assert.ok(sessionsDir().startsWith(dir));
    assert.match(sessionsDir(), /\.sessions$/);

    const s = createSession('u');
    assert.ok(s.workspace);
    assert.equal(s.workspace?.active_cwd, dir);
    assert.ok(existsSync(sessionPath(s.session_id)));
  });

  it('agent_home buckets by project_id under agent home', () => {
    const project = mkdtempSync(join(tmpdir(), 'sw-proj-'));
    const home = mkdtempSync(join(tmpdir(), 'sw-home-'));
    configureSessionStore({ mode: 'agent_home', agentHome: home, cwd: project });
    assert.equal(getSessionStoreMode(), 'agent_home');
    const pid = projectIdFromRoot(project);
    assert.equal(getProjectId(), pid);
    assert.ok(sessionsDir().includes(join('by-project', pid)));

    const s = createSession('u');
    const path = sessionPath(s.session_id);
    assert.ok(path.startsWith(home));
    assert.ok(existsSync(path));

    // Switching active cwd does not move session bucket
    const other = mkdtempSync(join(tmpdir(), 'sw-other-'));
    addWorkspaceGrant({
      root: other,
      mode: 'read_write',
      scope: 'session',
      granted_at: Date.now(),
    });
    setWorkspaceRoot(other);
    assert.equal(getWorkspaceRoot(), other);
    assert.equal(getProjectId(), pid);
    assert.ok(sessionsDir().includes(pid));
  });

  it('persists workspace grants on save/load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sw-grant-'));
    const extra = mkdtempSync(join(tmpdir(), 'sw-extra-'));
    configureSessionStore({ mode: 'project_local', cwd: dir });
    const s = createSession('u');
    addWorkspaceGrant({
      root: extra,
      mode: 'read_only',
      scope: 'session',
      granted_at: Date.now(),
      label: 'lab',
    });
    s.workspace = {
      project_id: getProjectId(),
      primary_root: dir,
      active_cwd: dir,
      workspace_grants: [
        {
          root: dir,
          mode: 'read_write',
          scope: 'session',
          granted_at: 1,
          label: 'primary',
        },
        {
          root: extra,
          mode: 'read_only',
          scope: 'session',
          granted_at: 2,
          label: 'lab',
        },
      ],
    };
    saveSession(s);
    const loaded = loadSession(s.session_id);
    assert.ok(loaded?.workspace?.workspace_grants.some((g) => g.label === 'lab'));
  });
});

describe('path grants', () => {
  beforeEach(() => {
    resetWorkspaceForTests();
  });

  it('allows write under read_write grant outside cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sw-cwd-'));
    const lab = mkdtempSync(join(tmpdir(), 'sw-lab-'));
    configureSessionStore({ mode: 'project_local', cwd });
    addWorkspaceGrant({
      root: lab,
      mode: 'read_write',
      scope: 'session',
      granted_at: Date.now(),
    });
    const file = join(lab, 'out.txt');
    const abs = resolveWritablePath(cwd, file);
    assert.equal(abs, file);
  });

  it('denies write under read_only grant', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sw-cwd2-'));
    const lab = mkdtempSync(join(tmpdir(), 'sw-lab2-'));
    configureSessionStore({ mode: 'project_local', cwd });
    addWorkspaceGrant({
      root: lab,
      mode: 'read_only',
      scope: 'session',
      granted_at: Date.now(),
    });
    assert.throws(
      () => resolveWritablePath(cwd, join(lab, 'x.txt')),
      /escapes working directory/,
    );
  });

  it('allows read under grant without JIT', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sw-cwd3-'));
    const lab = mkdtempSync(join(tmpdir(), 'sw-lab3-'));
    writeFileSync(join(lab, 'a.txt'), 'hi');
    configureSessionStore({ mode: 'project_local', cwd });
    addWorkspaceGrant({
      root: lab,
      mode: 'read_only',
      scope: 'session',
      granted_at: Date.now(),
    });
    const cfg = minimalConfig(cwd);
    const abs = await resolveReadablePath(cfg, join(lab, 'a.txt'), 'test');
    assert.equal(abs, join(lab, 'a.txt'));
  });
});
