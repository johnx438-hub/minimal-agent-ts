import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  cloakScriptCandidates,
  discoverCloakScript,
  ddgrCommandCandidates,
  expandUserPath,
  resolveCloakPython,
} from '../src/tools/cloak-resolve.js';

describe('cloak-resolve', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloak-resolve-'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('expandUserPath resolves relative against cwd', () => {
    const abs = expandUserPath('skills/cloak-fetch/cloak_fetch.py', dir);
    assert.equal(abs, join(dir, 'skills/cloak-fetch/cloak_fetch.py'));
  });

  it('discovers in-repo cloak_fetch.py under project cwd', () => {
    const skillDir = join(dir, 'skills', 'cloak-fetch');
    mkdirSync(skillDir, { recursive: true });
    const script = join(skillDir, 'cloak_fetch.py');
    writeFileSync(script, '# test\n', 'utf8');

    const found = discoverCloakScript({ cwd: dir });
    assert.equal(found, script);

    const candidates = cloakScriptCandidates({ cwd: dir });
    assert.ok(candidates.some((c) => c.includes('cloak_fetch.py')));
    // In-repo skill is preferred after env/config (index among auto paths)
    const repoIdx = candidates.findIndex((c) => c === script);
    assert.ok(repoIdx >= 0);
  });

  it('prefers configured script over auto paths', () => {
    const custom = join(dir, 'my_cloak.py');
    writeFileSync(custom, '# custom\n', 'utf8');
    const found = discoverCloakScript({ configured: custom, cwd: dir });
    assert.equal(found, custom);
  });

  it('ddgr candidates include win shims on win32 only', () => {
    const list = ddgrCommandCandidates('ddgr');
    assert.equal(list[0], 'ddgr');
    if (process.platform === 'win32') {
      assert.ok(list.includes('ddgr.exe'));
    }
  });

  it('resolveCloakPython returns a string (path or command name)', () => {
    const py = resolveCloakPython(undefined, dir);
    assert.ok(typeof py === 'string' && py.length > 0);
  });
});
