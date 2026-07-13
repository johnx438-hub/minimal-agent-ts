import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildGitDiffArgs,
  buildGitLogArgs,
  buildGitStatusArgs,
  runGitTool,
  truncateGitOutput,
} from '../src/tools/git.js';
import { BuiltinToolProvider } from '../src/tools/providers/builtin-provider.js';
import type { AgentConfig } from '../src/types.js';

function baseConfig(cwd: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiKey: 'k',
    baseUrl: 'https://example.com',
    model: 'test',
    maxTurns: 5,
    cwd,
    allowShell: true,
    allowWeb: false,
    sessionId: 'sess',
    ...overrides,
  };
}

function initGitRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'ma-git-tools-'));
  execFileSync('git', ['init'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  writeFileSync(join(cwd, 'a.ts'), 'export const a = 1;\n', 'utf8');
  execFileSync('git', ['add', 'a.ts'], { cwd });
  execFileSync('git', ['commit', '-m', 'init'], { cwd });
  return cwd;
}

describe('git argv builders', () => {
  it('buildGitStatusArgs defaults', () => {
    assert.deepEqual(buildGitStatusArgs({}), ['status', '--short', '-b']);
    assert.deepEqual(buildGitStatusArgs({ branch: false, untracked: false }), [
      'status',
      '--short',
      '-uno',
    ]);
  });

  it('buildGitDiffArgs supports staged and path', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ma-git-diff-args-'));
    const staged = buildGitDiffArgs(cwd, { staged: true });
    assert.ok(!('error' in staged));
    assert.deepEqual(staged, ['diff', '--no-ext-diff', '--no-color', '--cached']);

    writeFileSync(join(cwd, 'x.ts'), 'x', 'utf8');
    const withPath = buildGitDiffArgs(cwd, { path: 'x.ts' });
    assert.ok(!('error' in withPath));
    assert.ok(withPath.includes('--'));
    assert.ok(withPath.includes('x.ts'));
  });

  it('buildGitDiffArgs rejects path escape', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ma-git-escape-'));
    const bad = buildGitDiffArgs(cwd, { path: '../outside' });
    assert.ok('error' in bad);
  });

  it('buildGitLogArgs clamps max_count', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ma-git-log-args-'));
    const args = buildGitLogArgs(cwd, { max_count: 999 });
    assert.ok(!('error' in args));
    assert.ok(args.some((a) => a.startsWith('--max-count=50')));
  });

  it('truncateGitOutput marks truncation', () => {
    assert.match(truncateGitOutput('abcdefghij', 5), /truncated/);
  });
});

describe('runGitTool integration', () => {
  it('reports clean status and log for a fresh commit', async () => {
    const cwd = initGitRepo();
    const status = await runGitTool('git_status', {}, baseConfig(cwd));
    assert.ok(status);
    assert.ok(!status!.startsWith('error:'));
    // short -b usually includes branch name line
    assert.match(status!, /##|ok: clean|master|main/);

    const log = await runGitTool('git_log', { max_count: 5 }, baseConfig(cwd));
    assert.ok(log);
    assert.match(log!, /init/);
  });

  it('shows unstaged diff after edit', async () => {
    const cwd = initGitRepo();
    writeFileSync(join(cwd, 'a.ts'), 'export const a = 2;\n', 'utf8');
    const diff = await runGitTool('git_diff', { path: 'a.ts' }, baseConfig(cwd));
    assert.ok(diff);
    assert.match(diff!, /[+-].*a/);
  });

  it('errors outside a git repo', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ma-not-git-'));
    const out = await runGitTool('git_status', {}, baseConfig(cwd));
    assert.match(out ?? '', /not a git repository/);
  });

  it('returns null for non-git tool names', async () => {
    const out = await runGitTool('read_file', {}, baseConfig('/tmp'));
    assert.equal(out, null);
  });
});

describe('BuiltinToolProvider git tools', () => {
  it('hides git tools when shell is off', () => {
    const provider = new BuiltinToolProvider();
    provider.setEnabledForTests(['git_status', 'git_diff', 'read_file']);
    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig('/tmp', { allowShell: false }),
    });
    assert.deepEqual(defs.map((d) => d.function.name), ['read_file']);
  });

  it('exposes git tools when shell is on', () => {
    const provider = new BuiltinToolProvider();
    provider.setEnabledForTests(['git_status', 'git_diff', 'git_log']);
    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig('/tmp', { allowShell: true }),
    });
    assert.deepEqual(
      defs.map((d) => d.function.name).sort(),
      ['git_diff', 'git_log', 'git_status'],
    );
  });
});
