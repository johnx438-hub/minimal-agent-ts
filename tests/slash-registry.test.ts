import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseSlashLine,
  SLASH_HELP_LINES,
  slashAutocompleteItems,
} from '../src/tui/slash.js';

describe('slash registry', () => {
  it('formats bilingual help lines', () => {
    const resume = SLASH_HELP_LINES.find((l) => l.includes('/resume'));
    assert.ok(resume);
    assert.match(resume!, /最近活跃/);
    assert.match(resume!, /most recently active/);

    const mcp = SLASH_HELP_LINES.find((l) => l.includes('/mcp list'));
    assert.ok(mcp);
    assert.match(mcp!, /MCP/);
  });

  it('resolves aliases to primary commands', () => {
    assert.equal(parseSlashLine('/session')?.message, '__sessions__');
    assert.equal(parseSlashLine('/r last')?.message, '__resume_last__');
    assert.equal(parseSlashLine('/wf')?.message, '__workflow_list__');
    assert.equal(parseSlashLine('?')?.message, '__help__');
    assert.equal(parseSlashLine('/mcp')?.message, '__mcp_list__');
    assert.equal(parseSlashLine('/mcp list')?.message, '__mcp_list__');
  });

  it('exposes autocomplete items with bilingual descriptions', () => {
    const items = slashAutocompleteItems();
    const sessions = items.find((i) => i.name === 'sessions');
    assert.ok(sessions);
    assert.match(sessions!.description, /选择并恢复已保存会话/);
    assert.match(sessions!.description, /Pick and resume a saved session/);
    assert.equal(items.some((i) => i.name === 'session'), false);
  });
});