import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  resolveAgentProfile,
  resolvePromptFileWithFallback,
  stripForbiddenChildTools,
} from '../src/agent-profile.js';
import type { AgentPluginConfig } from '../src/plugins/types.js';
import { resolveWorkflowRole } from '../src/workflow/load-role.js';

function writeAgentMd(cwd: string, name: string, body: string): void {
  const agents = join(cwd, 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, name), body, 'utf8');
}

describe('workflow W1 preset resolve', () => {
  it('strips forbidden tools from any list', () => {
    assert.deepEqual(
      stripForbiddenChildTools([
        'read_file',
        'spawn_agent',
        'spawn_background',
        'code_review',
        'edit_file',
      ]),
      ['read_file', 'edit_file'],
    );
  });

  it('resolves preset from spawn_presets and allows tools override', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wf-preset-'));
    // No tools in frontmatter → agent.json tools apply (spawn historical merge).
    writeAgentMd(
      cwd,
      'worker.md',
      '---\ndescription: Worker\n---\nYou work.',
    );

    const plugin: AgentPluginConfig = {
      spawn_presets: [
        {
          name: 'dev-worker',
          description: 'Dev',
          prompt_file: 'agents/worker.md',
          tools: ['read_file', 'write_file', 'run_shell', 'spawn_agent'],
          max_turns: 50,
        },
      ],
      spawn_policy: { max_turns_cap: 80 },
    };

    const full = resolveAgentProfile(
      { name: 'worker', preset: 'dev-worker' },
      {
        cwd,
        spawnPresets: plugin.spawn_presets,
        spawnPolicy: plugin.spawn_policy,
        childKind: 'workflow',
      },
    );
    assert.ok(full.tools.includes('read_file'));
    assert.ok(full.tools.includes('write_file'));
    assert.ok(full.tools.includes('run_shell'));
    assert.ok(!full.tools.includes('spawn_agent'));
    assert.equal(full.maxTurns, 50);
    assert.match(full.systemPrompt, /You work/);

    const narrow = resolveAgentProfile(
      {
        name: 'reviewer',
        preset: 'dev-worker',
        tools: ['read_file', 'grep_search', 'spawn_background'],
        max_turns: 6,
      },
      {
        cwd,
        spawnPresets: plugin.spawn_presets,
        spawnPolicy: plugin.spawn_policy,
        childKind: 'workflow',
      },
    );
    assert.deepEqual(narrow.tools, ['read_file', 'grep_search']);
    assert.equal(narrow.maxTurns, 6);
  });

  it('resolveWorkflowRole loads repo dev-worker preset', () => {
    const cwd = process.cwd();
    const plugin = {
      spawn_presets: [
        {
          name: 'dev-worker',
          description: 'Full',
          prompt_file: 'agents/dev-worker.md',
          tools: [
            'read_file',
            'write_file',
            'edit_file',
            'run_shell',
            'spawn_agent',
            'code_review',
          ],
          max_turns: 50,
        },
      ],
      spawn_policy: { max_turns_cap: 80 },
    } satisfies AgentPluginConfig;

    const role = resolveWorkflowRole(
      'worker',
      { preset: 'dev-worker' },
      join(cwd, 'workflows/review-loop.json'),
      { cwd, workflowPath: join(cwd, 'workflows/review-loop.json'), pluginConfig: plugin },
    );

    assert.ok(role.tools.includes('run_shell'));
    assert.ok(role.tools.includes('edit_file'));
    assert.ok(!role.tools.includes('spawn_agent'));
    assert.ok(!role.tools.includes('code_review'));
    assert.equal(role.maxTurns, 50);
    assert.ok(role.shellPolicy || role.tools.includes('run_shell'));
  });

  it('prompt_file falls back to workflow-relative path', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wf-path-'));
    const wfDir = join(cwd, 'workflows');
    const rolesDir = join(cwd, 'roles');
    mkdirSync(wfDir, { recursive: true });
    mkdirSync(rolesDir, { recursive: true });
    writeFileSync(
      join(rolesDir, 'reviewer.md'),
      '---\ntools: read_file, diff_file\nmax_turns: 6\n---\nYou review.',
      'utf8',
    );
    const wfPath = join(wfDir, 'loop.json');
    writeFileSync(wfPath, '{}', 'utf8');

    const abs = resolvePromptFileWithFallback(cwd, '../roles/reviewer.md', wfPath);
    assert.ok(abs.endsWith('roles/reviewer.md'));

    const role = resolveWorkflowRole(
      'reviewer',
      {
        prompt_file: '../roles/reviewer.md',
        tools: ['read_file', 'grep_search', 'diff_file'],
        max_turns: 6,
      },
      wfPath,
      { cwd, workflowPath: wfPath },
    );
    assert.deepEqual(role.tools, ['read_file', 'grep_search', 'diff_file']);
    assert.match(role.systemPrompt, /You review/);
  });

  it('unknown preset throws with known names', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wf-miss-'));
    assert.throws(
      () =>
        resolveAgentProfile(
          { preset: 'nope' },
          {
            cwd,
            spawnPresets: [
              {
                name: 'dev-worker',
                prompt_file: 'agents/x.md',
                tools: [],
              },
            ],
          },
        ),
      /Unknown agent preset "nope"/,
    );
  });

  it('rejects prompt_file path escape outside cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wf-esc-'));
    assert.throws(
      () =>
        resolveAgentProfile(
          { name: 'x', prompt_file: '../../etc/passwd' },
          { cwd, childKind: 'workflow' },
        ),
      /escapes working directory/,
    );
  });
});
