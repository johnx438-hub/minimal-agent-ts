import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  executeMemorySlash,
  initUserMemoryFiles,
  loadWorkspaceMemoryInjection,
  MEMORY_DIR_REL,
  userMemoryFilePath,
} from '../src/workspace-memory.js';

describe('workspace memory', () => {
  it('init creates template files once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-mem-'));
    const created = initUserMemoryFiles(dir);
    assert.equal(created.length, 3);
    assert.equal(existsSync(userMemoryFilePath(dir, 'profile')), true);

    const again = initUserMemoryFiles(dir);
    assert.equal(again.length, 0);
  });

  it('injects profile and requirements but not archives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-mem-'));
    initUserMemoryFiles(dir);
    writeFileSync(userMemoryFilePath(dir, 'profile'), '# me\nPrefer concise replies.');
    writeFileSync(userMemoryFilePath(dir, 'requirements'), '# rules\nAlways run tests.');
    writeFileSync(userMemoryFilePath(dir, 'archives'), '# archives\n2026-01-01 | big task');

    const injection = loadWorkspaceMemoryInjection(dir);
    assert.ok(injection);
    assert.equal(injection!.files.length, 2);
    assert.match(injection!.files.map((f) => f.key).join(','), /profile/);
    assert.match(injection!.files.map((f) => f.key).join(','), /requirements/);
    assert.doesNotMatch(injection!.files.map((f) => f.key).join(','), /archives/);
  });

  it('truncates combined injection budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-mem-'));
    initUserMemoryFiles(dir);
    writeFileSync(userMemoryFilePath(dir, 'profile'), 'p'.repeat(100));
    writeFileSync(userMemoryFilePath(dir, 'requirements'), 'r'.repeat(100));

    const injection = loadWorkspaceMemoryInjection(dir, { maxChars: 120 });
    assert.ok(injection?.truncated);
    assert.equal(injection!.combinedChars, 120);
  });

  it('executeMemorySlash init returns error instead of throwing on FS failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-mem-'));
    mkdirSync(join(dir, '.agent'));
    writeFileSync(join(dir, '.agent', 'memory'), 'not a directory');

    const out = executeMemorySlash(dir, { type: 'init' });
    assert.match(out, /^Failed to create memory files:/);
  });

  it('executes memory slash status and show', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-mem-'));
    initUserMemoryFiles(dir);
    writeFileSync(userMemoryFilePath(dir, 'profile'), 'hello profile');

    const status = executeMemorySlash(dir, { type: 'status' });
    assert.match(status, new RegExp(MEMORY_DIR_REL));
    assert.match(status, /profile\.md/);

    const show = executeMemorySlash(dir, { type: 'show', file: 'profile' });
    assert.match(show, /hello profile/);
  });
});