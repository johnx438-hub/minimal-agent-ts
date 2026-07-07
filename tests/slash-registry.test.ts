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
    assert.equal(parseSlashLine('/log')?.message, '__log__');
    assert.equal(parseSlashLine('/log session_x')?.message, '__log__:session_x');
    assert.equal(parseSlashLine('/history')?.message, '__history__');
    assert.equal(parseSlashLine('/history session_x')?.message, '__history__:session_x');
    assert.equal(parseSlashLine('/memory')?.memoryAction?.type, 'status');
    assert.equal(parseSlashLine('/memory init')?.memoryAction?.type, 'init');
    assert.equal(parseSlashLine('/memory show profile')?.memoryAction?.file, 'profile');
  });

  it('exposes autocomplete items with bilingual descriptions', () => {
    const items = slashAutocompleteItems();
    const sessions = items.find((i) => i.name === 'sessions');
    assert.ok(sessions);
    assert.match(sessions!.description, /选择并恢复已保存会话/);

    const skills = items.find((i) => i.name === 'skills');
    assert.ok(skills);
    assert.match(skills!.description, /选择并加载 skill/);

    const workflow = items.find((i) => i.name === 'workflow');
    assert.ok(workflow);
    assert.match(workflow!.description, /选择并武装 workflow/);

    const log = SLASH_HELP_LINES.find((l) => l.includes('/log'));
    assert.ok(log);
    assert.match(log!, /审计当前会话/);

    const history = SLASH_HELP_LINES.find((l) => l.includes('/history'));
    assert.ok(history);
    assert.match(history!, /对话时间线/);
    assert.match(history!, /conversation timeline/);
    assert.equal(items.some((i) => i.name === 'session'), false);
  });
});