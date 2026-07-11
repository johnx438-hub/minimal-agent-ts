import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SkillDefinition } from '../src/plugins/types.js';
import { SkillsToolProvider } from '../src/tools/providers/skills-provider.js';
import type { AgentConfig } from '../src/types.js';

function sampleSkill(name: string): SkillDefinition {
  return {
    name,
    description: `${name} guidance`,
    path: `/tmp/skills/${name}/SKILL.md`,
    body: `# ${name}\nDo the thing.`,
  };
}

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

describe('SkillsToolProvider', () => {
  it('exposes invoke_skill def when enabled', () => {
    const provider = new SkillsToolProvider();
    provider.setSkillsForTests(new Map([['context-design', sampleSkill('context-design')]]));

    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig(),
    });
    assert.equal(defs.length, 1);
    assert.equal(defs[0]!.function.name, 'invoke_skill');
  });

  it('omits invoke_skill def when builtin tool is disabled', () => {
    const provider = new SkillsToolProvider();
    provider.setSkillsForTests(new Map(), ['read_file']);

    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig(),
    });
    assert.deepEqual(defs, []);
  });

  it('lists available skills when name is omitted', async () => {
    const provider = new SkillsToolProvider();
    provider.setSkillsForTests(
      new Map([
        ['alpha', sampleSkill('alpha')],
        ['beta', sampleSkill('beta')],
      ]),
    );

    const out = await provider.execute(
      'invoke_skill',
      {},
      { cwd: '/tmp', pluginConfig: {}, config: baseConfig() },
    );
    assert.match(out!, /Available skills:/);
    assert.match(out!, /alpha/);
    assert.match(out!, /beta/);
  });

  it('loads a named skill body', async () => {
    const provider = new SkillsToolProvider();
    provider.setSkillsForTests(new Map([['context-design', sampleSkill('context-design')]]));

    const out = await provider.execute(
      'invoke_skill',
      { name: 'context-design', query: 'pointerize policy' },
      { cwd: '/tmp', pluginConfig: {}, config: baseConfig() },
    );
    assert.match(out!, /Skill: context-design/);
    assert.match(out!, /Focus query/);
    assert.match(out!, /pointerize policy/);
  });

  it('returns null for non-skill tools', async () => {
    const provider = new SkillsToolProvider();
    provider.setSkillsForTests(new Map());

    const out = await provider.execute(
      'read_file',
      { path: 'a.ts' },
      { cwd: '/tmp', pluginConfig: {}, config: baseConfig() },
    );
    assert.equal(out, null);
  });

  it('builds loaded skills system extension', () => {
    const provider = new SkillsToolProvider();
    provider.setSkillsForTests(
      new Map([
        ['alpha', sampleSkill('alpha')],
        ['beta', sampleSkill('beta')],
      ]),
    );

    const block = provider.getSkillSystemExtension(['alpha']);
    assert.match(block, /alpha/);
    assert.doesNotMatch(block, /beta/);
  });

  it('lists discovered skill names', () => {
    const provider = new SkillsToolProvider();
    provider.setSkillsForTests(new Map([['alpha', sampleSkill('alpha')]]));

    assert.deepEqual(provider.listSkillNames(), ['alpha']);
  });
});