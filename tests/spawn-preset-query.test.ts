import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { AgentPluginConfig } from '../src/plugins/types.js';
import {
  buildSpawnPresetEntries,
  formatSpawnPresetDetail,
  formatSpawnPresetListLine,
  listOrphanAgentFiles,
} from '../src/spawn/preset-query.js';
import type { ResolvedSpawnPreset } from '../src/spawn/types.js';

function writeAgentMd(dir: string, name: string, body: string): void {
  const agents = join(dir, 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, name), body, 'utf8');
}

describe('spawn preset query', () => {
  it('builds registered preset entries with agent.json metadata', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'spawn-preset-query-'));
    writeAgentMd(
      cwd,
      'web-researcher.md',
      '---\ndescription: Web lookup\ntools: web_fetch, read_file\n---\nYou research.',
    );

    const pluginConfig: AgentPluginConfig = {
      spawn_presets: [
        {
          name: 'web-researcher',
          description: 'Delegate web lookup',
          prompt_file: 'agents/web-researcher.md',
          tools: ['web_fetch', 'read_file'],
          max_turns: 12,
          api_profile: 'openrouter-test',
          model: 'deepseek/deepseek-v4-flash',
        },
      ],
    };

    const resolved: ResolvedSpawnPreset[] = [
      {
        name: 'web-researcher',
        description: 'Delegate web lookup',
        systemPrompt: 'You research.',
        tools: ['web_fetch', 'read_file'],
        maxTurns: 12,
      },
    ];

    const [entry] = buildSpawnPresetEntries(cwd, pluginConfig, resolved);
    assert.equal(entry.name, 'web-researcher');
    assert.equal(entry.maxTurns, 12);
    assert.equal(entry.promptFile, 'agents/web-researcher.md');
    assert.equal(entry.apiProfile, 'openrouter-test');
    assert.equal(entry.model, 'deepseek/deepseek-v4-flash');
    assert.equal(entry.registered, true);

    assert.match(formatSpawnPresetListLine(entry), /web-researcher/);
    assert.match(formatSpawnPresetDetail(entry), /api_profile: openrouter-test/);
    assert.match(formatSpawnPresetDetail(entry), /spawn_agent/);
  });

  it('lists orphan agents/*.md not wired in spawn_presets', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'spawn-preset-orphan-'));
    writeAgentMd(
      cwd,
      'registered.md',
      '---\ndescription: Registered agent\n---\nBody',
    );
    writeAgentMd(
      cwd,
      'orphan.md',
      '---\ndescription: Orphan scout\n---\nBody',
    );

    const pluginConfig: AgentPluginConfig = {
      spawn_presets: [
        {
          name: 'registered',
          description: 'Registered',
          prompt_file: 'agents/registered.md',
          tools: ['read_file'],
        },
      ],
    };

    const orphans = listOrphanAgentFiles(cwd, pluginConfig);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0]!.relativePath, 'agents/orphan.md');
    assert.equal(orphans[0]!.description, 'Orphan scout');
  });

  it('returns no orphans when agents/ is missing', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'spawn-preset-no-agents-'));
    const orphans = listOrphanAgentFiles(cwd, {});
    assert.deepEqual(orphans, []);
  });
});