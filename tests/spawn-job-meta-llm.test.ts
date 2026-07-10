import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { buildJobLlmMeta } from '../src/llm-profiles.js';
import type { AgentPluginConfig } from '../src/plugins/types.js';
import { formatJobList, formatJobLlmTag } from '../src/spawn/job-cli.js';
import { getJobRegistry, resetJobRegistryForTests } from '../src/spawn/job-registry.js';
import { readJobMeta } from '../src/spawn/job-store.js';
import { setSpawnRunnerForTests } from '../src/spawn/job-runner.js';
import type { AgentConfig } from '../src/types.js';
import { setWorkspaceRoot } from '../src/workspace.js';

const DEEPSEEK = {
  base_url: 'https://api.deepseek.com',
  api_key_env: 'DEEPSEEK_API_KEY',
  default_model: 'deepseek-v4-flash',
  cache: { mode: 'implicit' as const },
};

const GLM = {
  base_url: 'https://open.bigmodel.cn/api/paas/v4/',
  api_key_env: 'ZAI_API_KEY',
  default_model: 'glm-5.2',
  cache: { mode: 'implicit' as const },
};

const SECURITY = {
  base_url: 'https://api.deepseek.com',
  api_key_env: 'DEEPSEEK_API_KEY',
  default_model: 'deepseek-v4-pro',
  cache: { mode: 'implicit' as const },
};

function pluginConfig(): AgentPluginConfig {
  return {
    default_api_profile: 'deepseek-main',
    api_profiles: {
      'deepseek-main': DEEPSEEK,
      'glm-review': GLM,
      'security-pass': SECURITY,
    },
    spawn_presets: [
      {
        name: 'code-review-bug',
        prompt_file: 'agents/code-review-bug.md',
        tools: ['read_file'],
        api_profile: 'glm-review',
        model: 'glm-4.7-flash',
      },
      {
        name: 'code-review-security',
        prompt_file: 'agents/code-review-security.md',
        tools: ['read_file'],
        api_profile: 'security-pass',
        model: 'deepseek-v4-pro',
      },
      {
        name: 'code-review-quality',
        prompt_file: 'agents/code-review-quality.md',
        tools: ['read_file'],
        api_profile: 'deepseek-main',
      },
    ],
  };
}

function parentConfig(sessionId: string, cwd: string): AgentConfig {
  const llmPluginConfig = pluginConfig();

  return {
    apiKey: 'ds-key',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    maxTurns: 8,
    cwd,
    allowShell: false,
    allowWeb: false,
    sessionId,
    llm: {
      profileName: 'deepseek-main',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'ds-key',
      model: 'deepseek-v4-flash',
      wire: 'openai_chat',
      cache: { mode: 'implicit' },
      available: true,
    },
    llmPluginConfig,
  };
}

const reviewPresets = [
  {
    name: 'code-review-bug',
    description: 'bug',
    systemPrompt: 'bug',
    tools: ['read_file'],
    maxTurns: 6,
  },
  {
    name: 'code-review-security',
    description: 'security',
    systemPrompt: 'security',
    tools: ['read_file'],
    maxTurns: 6,
  },
  {
    name: 'code-review-quality',
    description: 'quality',
    systemPrompt: 'quality',
    tools: ['read_file'],
    maxTurns: 6,
  },
];

describe('spawn job meta llm (G2-b)', () => {
  let tempDir = '';

  afterEach(() => {
    setSpawnRunnerForTests(null);
    resetJobRegistryForTests();
  });

  it('buildJobLlmMeta resolves per-preset api_profile and model', () => {
    const config = parentConfig('sess', '/tmp');
    const bug = buildJobLlmMeta(config, 'code-review-bug', {
      env: { ZAI_API_KEY: 'glm-key' },
    });
    assert.deepEqual(bug, {
      api_profile: 'glm-review',
      model: 'glm-4.7-flash',
      llm_base_url: 'https://open.bigmodel.cn/api/paas/v4',
      cache_mode: 'implicit',
    });

    const security = buildJobLlmMeta(config, 'code-review-security', {
      env: { DEEPSEEK_API_KEY: 'ds-key' },
    });
    assert.equal(security?.api_profile, 'security-pass');
    assert.equal(security?.model, 'deepseek-v4-pro');

    const quality = buildJobLlmMeta(config, 'code-review-quality', {
      env: { DEEPSEEK_API_KEY: 'ds-key' },
    });
    assert.equal(quality?.api_profile, 'deepseek-main');
    assert.equal(quality?.model, 'deepseek-v4-flash');
  });

  it('writes distinct llm fields for parallel code_review jobs', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-job-meta-llm-'));
    setWorkspaceRoot(tempDir);
    setSpawnRunnerForTests(async () => 'ok');

    const registry = getJobRegistry();
    const sessionId = 'session_meta_llm_parallel';
    const config = parentConfig(sessionId, tempDir);
    const handles = reviewPresets.map((preset) =>
      registry.start({
        preset,
        task: `review ${preset.name}`,
        parentConfig: config,
      }),
    );

    await Promise.all(handles.map((h) => h.promise));

    const metas = handles.map((h) => readJobMeta(h.jobId)!);
    const profiles = new Set(metas.map((m) => m.api_profile));
    const models = new Set(metas.map((m) => m.model));

    assert.equal(profiles.size, 3);
    assert.equal(models.size, 3);
    assert.ok(metas.every((m) => m.llm_base_url));
    assert.ok(metas.every((m) => m.cache_mode === 'implicit'));

    const bugMeta = metas.find((m) => m.preset === 'code-review-bug');
    assert.equal(bugMeta?.api_profile, 'glm-review');
    assert.equal(bugMeta?.model, 'glm-4.7-flash');
  });

  it('formatJobList shows llm column', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-job-meta-list-'));
    setWorkspaceRoot(tempDir);
    setSpawnRunnerForTests(async () => 'done');

    const registry = getJobRegistry();
    const handle = registry.start({
      preset: reviewPresets[0]!,
      task: 'list llm tag',
      parentConfig: parentConfig('session_meta_list', tempDir),
    });
    await handle.promise;

    const meta = readJobMeta(handle.jobId)!;
    assert.equal(formatJobLlmTag(meta), 'glm-review/glm-4.7-flash');

    const list = formatJobList({ limit: 5 });
    assert.match(list, /LLM/);
    assert.ok(list.includes('glm-review/glm-4.7-flash'));
    assert.ok(list.includes('code-review-bug'));
  });
});