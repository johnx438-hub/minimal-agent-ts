import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveSpawnPreset } from '../src/spawn/load-preset.js';

function writeAgentMd(
  cwd: string,
  name: string,
  body: string,
): void {
  const agents = join(cwd, 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, name), body, 'utf8');
}

describe('load spawn preset', () => {
  it('strips spawn_agent, spawn_background, and code_review from agent.json tools', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'load-spawn-preset-'));
    writeAgentMd(cwd, 'worker.md', '---\ndescription: Worker\n---\nYou work.');

    const preset = resolveSpawnPreset(cwd, {
      name: 'worker',
      description: 'Worker preset',
      prompt_file: 'agents/worker.md',
      tools: [
        'read_file',
        'spawn_agent',
        'spawn_background',
        'code_review',
        'grep_search',
      ],
    });

    assert.deepEqual(preset.tools, ['read_file', 'grep_search']);
    assert.match(preset.systemPrompt, /Allowed tools: read_file, grep_search/);
    assert.match(preset.systemPrompt, /Do not call spawn_agent or spawn_background/);
  });

  it('strips forbidden spawn tools from frontmatter tools list', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'load-spawn-preset-fm-'));
    writeAgentMd(
      cwd,
      'worker.md',
      '---\ndescription: Worker\ntools: read_file, spawn_agent, spawn_background, web_fetch\n---\nYou work.',
    );

    const preset = resolveSpawnPreset(cwd, {
      name: 'worker',
      description: 'Worker preset',
      prompt_file: 'agents/worker.md',
      tools: ['write_file'],
    });

    assert.deepEqual(preset.tools, ['read_file', 'web_fetch']);
  });

  it('loads repo dev-worker with full coding tools and stress-friendly turns', () => {
    const cwd = process.cwd();
    const preset = resolveSpawnPreset(
      cwd,
      {
        name: 'dev-worker',
        description: 'Full-tools coding worker',
        prompt_file: 'agents/dev-worker.md',
        tools: [
          'read_file',
          'write_file',
          'edit_file',
          'apply_patch',
          'grep_search',
          'list_files',
          'diff_file',
          'recall_query',
          'invoke_skill',
          'run_shell',
          'git_status',
          'git_diff',
          'git_log',
          'lsp_query',
          'web_fetch',
          'web_search',
          'spawn_agent',
          'code_review',
        ],
        max_turns: 50,
      },
      { max_turns_default: 15, max_turns_cap: 80, max_parallel: 3 },
    );

    assert.equal(preset.name, 'dev-worker');
    assert.equal(preset.maxTurns, 50);
    assert.ok(preset.tools.includes('run_shell'));
    assert.ok(preset.tools.includes('git_status'));
    assert.ok(preset.tools.includes('lsp_query'));
    assert.ok(preset.tools.includes('apply_patch'));
    assert.ok(preset.tools.includes('edit_file'));
    assert.ok(!preset.tools.includes('spawn_agent'));
    assert.ok(!preset.tools.includes('code_review'));
    assert.match(preset.systemPrompt, /dev-worker/i);
  });
});