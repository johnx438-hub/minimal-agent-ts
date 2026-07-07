import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildSystemPrompt } from '../src/agent-prompt.js';
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
  it('appends Agent.md when present in cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-prompt-'));
    writeFileSync(join(dir, 'Agent.md'), '## Rules\nAlways run tests.');

    const prompt = buildSystemPrompt(minimalConfig(dir));
    assert.match(prompt, /minimal coding assistant/);
    assert.match(prompt, /Workspace agent instructions/);
    assert.match(prompt, /Always run tests/);
    assert.match(prompt, /Source: Agent\.md/);
  });

  it('omits workspace block when Agent.md is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-prompt-'));
    const prompt = buildSystemPrompt(minimalConfig(dir));
    assert.doesNotMatch(prompt, /Workspace agent instructions/);
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