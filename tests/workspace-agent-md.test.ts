import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  findWorkspaceAgentMdPath,
  formatWorkspaceAgentMdBlock,
  loadWorkspaceAgentMd,
  WORKSPACE_AGENT_MD_FILENAMES,
} from '../src/workspace-agent-md.js';

describe('workspace Agent.md loader', () => {
  it('prefers Agent.md over AGENTS.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-md-'));
    writeFileSync(join(dir, 'AGENTS.md'), '# agents');
    writeFileSync(join(dir, 'Agent.md'), '# agent');

    assert.equal(findWorkspaceAgentMdPath(dir)?.endsWith('Agent.md'), true);
    const doc = loadWorkspaceAgentMd(dir);
    assert.equal(doc?.content, '# agent');
  });

  it('falls back to AGENTS.md when Agent.md is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-md-'));
    writeFileSync(join(dir, 'AGENTS.md'), '# from agents');

    const doc = loadWorkspaceAgentMd(dir);
    assert.equal(doc?.relativePath, 'AGENTS.md');
    assert.equal(doc?.content, '# from agents');
  });

  it('returns null for empty or missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-md-'));
    assert.equal(loadWorkspaceAgentMd(dir), null);

    writeFileSync(join(dir, 'Agent.md'), '   \n  ');
    assert.equal(loadWorkspaceAgentMd(dir), null);
  });

  it('truncates long content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-md-'));
    writeFileSync(join(dir, 'Agent.md'), 'x'.repeat(200));
    const doc = loadWorkspaceAgentMd(dir, { maxChars: 50 });
    assert.equal(doc?.content.length, 50);
    assert.equal(doc?.truncated, true);
    const block = formatWorkspaceAgentMdBlock(doc!);
    assert.match(block, /truncated/i);
  });

  it('documents filename order', () => {
    assert.deepEqual(WORKSPACE_AGENT_MD_FILENAMES, ['Agent.md', 'AGENTS.md']);
  });
});