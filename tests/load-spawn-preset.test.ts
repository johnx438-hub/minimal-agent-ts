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
  it('strips spawn_agent and spawn_background from agent.json tools', () => {
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
});