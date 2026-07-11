import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SpawnToolProvider } from '../src/tools/providers/spawn-provider.js';
import type { ResolvedSpawnPreset } from '../src/spawn/types.js';
import type { AgentConfig } from '../src/types.js';

const demoPreset: ResolvedSpawnPreset = {
  name: 'demo-preset',
  description: 'Demo agent for tests',
  systemPrompt: 'You are a demo agent.',
  tools: ['read_file'],
  maxTurns: 5,
};

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiKey: 'k',
    baseUrl: 'https://example.com',
    model: 'test',
    maxTurns: 5,
    cwd: '/tmp',
    allowShell: false,
    allowWeb: false,
    sessionId: 'sess',
    ...overrides,
  };
}

describe('SpawnToolProvider', () => {
  it('exposes spawn defs when presets and builtin tools are enabled', () => {
    const provider = new SpawnToolProvider();
    provider.setPresetsForTests([demoPreset], ['spawn_agent', 'spawn_background']);

    const ctx = {
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig(),
    };

    const defs = provider.getDefinitions(ctx);
    assert.equal(defs.length, 2);
    assert.deepEqual(
      defs.map((d) => d.function.name).sort(),
      ['spawn_agent', 'spawn_background'],
    );
    assert.match(defs[0]!.function.description, /demo-preset/);
  });

  it('omits spawn defs when builtin tools are disabled', () => {
    const provider = new SpawnToolProvider();
    provider.setPresetsForTests([demoPreset], ['read_file']);

    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig(),
    });
    assert.deepEqual(defs, []);
  });

  it('omits spawn defs inside a spawned sub-agent (spawnDepth > 0)', () => {
    const provider = new SpawnToolProvider();
    provider.setPresetsForTests([demoPreset], ['spawn_agent', 'spawn_background']);

    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig({ spawnDepth: 1 }),
    });
    assert.deepEqual(defs, []);
  });

  it('respects role allowlist for spawn tools', () => {
    const provider = new SpawnToolProvider();
    provider.setPresetsForTests([demoPreset], ['spawn_agent', 'spawn_background']);

    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig({ toolAllowlist: ['spawn_background'] }),
    });
    assert.equal(defs.length, 1);
    assert.equal(defs[0]!.function.name, 'spawn_background');
  });

  it('returns null for non-spawn tools', async () => {
    const provider = new SpawnToolProvider();
    provider.setPresetsForTests([demoPreset]);

    const out = await provider.execute(
      'read_file',
      { path: 'a.ts' },
      { cwd: '/tmp', pluginConfig: {}, config: baseConfig() },
    );
    assert.equal(out, null);
  });

  it('reports configuration error when spawn tool is disabled', async () => {
    const provider = new SpawnToolProvider();
    provider.setPresetsForTests([demoPreset], ['spawn_background']);

    const out = await provider.execute(
      'spawn_agent',
      { preset: 'demo-preset', task: 'x' },
      { cwd: '/tmp', pluginConfig: {}, config: baseConfig() },
    );
    assert.match(out!, /spawn_agent is not configured/);
  });

  it('reports missing preset argument', async () => {
    const provider = new SpawnToolProvider();
    provider.setPresetsForTests([demoPreset]);

    const out = await provider.execute(
      'spawn_agent',
      { task: 'inspect README' },
      { cwd: '/tmp', pluginConfig: {}, config: baseConfig() },
    );
    assert.match(out!, /preset is required/);
  });

  it('lists preset names for registry consumers', () => {
    const provider = new SpawnToolProvider();
    provider.setPresetsForTests([demoPreset, { ...demoPreset, name: 'other' }]);

    assert.equal(provider.hasSpawnPresets(), true);
    assert.deepEqual(provider.listSpawnPresetNames(), ['demo-preset', 'other']);
    assert.equal(provider.getSpawnPresets().length, 2);
  });
});