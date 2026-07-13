import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  applyHunksToContent,
  parseUnifiedDiff,
  planPatchApplication,
  runApplyPatchTool,
} from '../src/tools/apply-patch.js';
import type { AgentConfig } from '../src/types.js';

function cfg(cwd: string): AgentConfig {
  return {
    apiKey: 'k',
    baseUrl: 'https://example.com',
    model: 't',
    maxTurns: 5,
    cwd,
    allowShell: false,
    allowWeb: false,
  };
}

describe('parseUnifiedDiff', () => {
  it('parses a single-file hunk', () => {
    const patch = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-old',
      '+new',
      ' line3',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(patch);
    assert.ok(!('error' in files));
    assert.equal(files.length, 1);
    assert.equal(files[0]!.path, 'foo.ts');
    assert.equal(files[0]!.hunks.length, 1);
  });

  it('parses multi-file and new file', () => {
    const patch = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '--- /dev/null',
      '+++ b/b.ts',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(patch);
    assert.ok(!('error' in files));
    assert.equal(files.length, 2);
    assert.equal(files[1]!.isNew, true);
    assert.equal(files[1]!.path, 'b.ts');
  });

  it('rejects empty patch', () => {
    const r = parseUnifiedDiff('   ');
    assert.ok('error' in r);
  });
});

describe('applyHunksToContent', () => {
  it('replaces a unique line', () => {
    const content = 'a\nold\nc\n';
    const files = parseUnifiedDiff(
      [
        '--- a/x',
        '+++ b/x',
        '@@ -1,3 +1,3 @@',
        ' a',
        '-old',
        '+new',
        ' c',
        '',
      ].join('\n'),
    );
    assert.ok(!('error' in files));
    const out = applyHunksToContent(content, files[0]!.hunks);
    assert.ok(!('error' in out));
    assert.equal(out.content, 'a\nnew\nc\n');
  });
});

describe('runApplyPatchTool', () => {
  it('dry_run does not write', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ma-patch-dry-'));
    writeFileSync(join(cwd, 'f.ts'), ' cons t x = 1;\n', 'utf8');
    // fix content
    writeFileSync(join(cwd, 'f.ts'), 'const x = 1;\n', 'utf8');
    const patch = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1 +1 @@',
      '-const x = 1;',
      '+const x = 2;',
      '',
    ].join('\n');
    const out = await runApplyPatchTool(
      'apply_patch',
      { patch, dry_run: true },
      cfg(cwd),
    );
    assert.match(out ?? '', /dry_run/);
    assert.equal(readFileSync(join(cwd, 'f.ts'), 'utf8'), 'const x = 1;\n');
  });

  it('applies multi-file patch', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ma-patch-multi-'));
    writeFileSync(join(cwd, 'a.ts'), 'export const a = 1;\n', 'utf8');
    const patch = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-export const a = 1;',
      '+export const a = 2;',
      '--- /dev/null',
      '+++ b/b.ts',
      '@@ -0,0 +1 @@',
      '+export const b = 3;',
      '',
    ].join('\n');
    const out = await runApplyPatchTool('apply_patch', { patch }, cfg(cwd));
    assert.match(out ?? '', /ok: apply_patch 2/);
    assert.equal(readFileSync(join(cwd, 'a.ts'), 'utf8'), 'export const a = 2;\n');
    assert.equal(readFileSync(join(cwd, 'b.ts'), 'utf8'), 'export const b = 3;\n');
  });

  it('rejects path escape', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ma-patch-esc-'));
    const patch = [
      '--- a/../outside.ts',
      '+++ b/../outside.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '',
    ].join('\n');
    const out = await runApplyPatchTool('apply_patch', { patch }, cfg(cwd));
    assert.match(out ?? '', /escape|error:/);
  });

  it('fails when context does not match', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ma-patch-miss-'));
    writeFileSync(join(cwd, 'f.ts'), 'hello\n', 'utf8');
    const patch = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1 +1 @@',
      '-goodbye',
      '+hola',
      '',
    ].join('\n');
    const out = await runApplyPatchTool('apply_patch', { patch }, cfg(cwd));
    assert.match(out ?? '', /hunk not found|error:/);
    assert.equal(readFileSync(join(cwd, 'f.ts'), 'utf8'), 'hello\n');
  });
});

describe('planPatchApplication', () => {
  it('stages creates and patches', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ma-plan-'));
    writeFileSync(join(cwd, 'a.ts'), 'a\n', 'utf8');
    const files = parseUnifiedDiff(
      [
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '--- /dev/null',
        '+++ b/c.ts',
        '@@ -0,0 +1 @@',
        '+c',
        '',
      ].join('\n'),
    );
    assert.ok(!('error' in files));
    const plan = planPatchApplication(cwd, files, (abs) => {
      try {
        return readFileSync(abs, 'utf8');
      } catch {
        return null;
      }
    });
    assert.ok(!('error' in plan));
    assert.equal(plan.length, 2);
  });
});
