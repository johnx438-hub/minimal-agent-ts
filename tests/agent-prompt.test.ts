import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildSystemPrompt,
  loadWorkspacePromptBundle,
  resolveActiveModelLabel,
  workspacePromptRunStartMeta,
} from '../src/agent-prompt.js';
import type { AgentConfig } from '../src/types.js';
import { initUserMemoryFiles, userMemoryFilePath } from '../src/workspace-memory.js';

function minimalConfig(cwd: string): AgentConfig {
  return {
    apiKey: 'test',
    baseUrl: 'https://example.com',
    model: 'test-model',
    maxTurns: 0,
    cwd,
    allowShell: false,
    allowWeb: false,
  };
}

describe('buildSystemPrompt', () => {
  it('includes the active model in the system prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-prompt-'));
    const prompt = buildSystemPrompt(minimalConfig(dir));
    assert.match(prompt, /Active model: test-model\./);
  });

  it('prefers llm.model and displayName when set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-prompt-'));
    const cfg: AgentConfig = {
      ...minimalConfig(dir),
      model: 'stale-model',
      llm: {
        profileName: 'deepseek-main',
        baseUrl: 'https://example.com',
        apiKey: 'k',
        model: 'deepseek-v4-flash',
        wire: 'openai_chat',
        displayName: 'DeepSeek V4',
        available: true,
      },
    };
    assert.equal(resolveActiveModelLabel(cfg), 'deepseek-v4-flash (DeepSeek V4)');
    assert.match(buildSystemPrompt(cfg), /Active model: deepseek-v4-flash \(DeepSeek V4\)\./);
  });

  it('appends Agent.md when present in cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-prompt-'));
    writeFileSync(join(dir, 'Agent.md'), '## Rules\nAlways run tests.');

    const prompt = buildSystemPrompt(minimalConfig(dir));
    assert.match(prompt, /minimal coding assistant/);
    assert.match(prompt, /Active model: test-model\./);
    assert.match(prompt, /Workspace agent instructions/);
    assert.match(prompt, /Always run tests/);
    assert.match(prompt, /Source: Agent\.md/);
  });

  it('omits workspace block when Agent.md is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-prompt-'));
    const prompt = buildSystemPrompt(minimalConfig(dir));
    assert.doesNotMatch(prompt, /Workspace agent instructions/);
  });

  it('workspacePrompt bundle keeps run_start meta aligned with prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-prompt-'));
    writeFileSync(join(dir, 'Agent.md'), 'Workspace rules here.');
    initUserMemoryFiles(dir);
    writeFileSync(userMemoryFilePath(dir, 'profile'), 'Memory line.');

    const bundle = loadWorkspacePromptBundle(dir);
    const meta = workspacePromptRunStartMeta(bundle);
    const prompt = buildSystemPrompt({ ...minimalConfig(dir), workspacePrompt: bundle });

    assert.equal(meta.agent_md?.chars, bundle.agentMd?.content.length);
    assert.equal(meta.memory?.profile_chars, bundle.memory?.files.find((f) => f.key === 'profile')?.content.length);
    assert.match(prompt, /Workspace rules here/);
    assert.match(prompt, /Memory line/);
  });

  it('appends cross-session memory when profile exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-prompt-'));
    initUserMemoryFiles(dir);
    writeFileSync(userMemoryFilePath(dir, 'profile'), 'Prefer TypeScript.');

    const prompt = buildSystemPrompt(minimalConfig(dir));
    assert.match(prompt, /Cross-session memory/);
    assert.match(prompt, /Prefer TypeScript/);
  });
});