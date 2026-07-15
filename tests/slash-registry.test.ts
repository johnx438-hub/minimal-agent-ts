import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatSlashHelpLines,
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

  it('formats locale-specific help lines', () => {
    const zh = formatSlashHelpLines('zh').find((l) => l.includes('/resume'));
    const en = formatSlashHelpLines('en').find((l) => l.includes('/resume'));
    assert.match(zh!, /最近活跃/);
    assert.doesNotMatch(zh!, /most recently active/);
    assert.match(en!, /most recently active/);
    assert.doesNotMatch(en!, /最近活跃/);
  });

  it('parses /lang', () => {
    assert.equal(parseSlashLine('/lang')?.message, '__lang__');
    assert.equal(parseSlashLine('/lang zh')?.message, '__lang__:zh');
    assert.equal(parseSlashLine('/locale en')?.message, '__lang__:en');
    assert.equal(parseSlashLine('/lang fr')?.message, '__lang_usage__');
  });

  it('resolves aliases to primary commands', () => {
    assert.equal(parseSlashLine('/r last')?.message, '__resume_last__');
    assert.equal(parseSlashLine('/wf')?.message, '__workflow_list__');
    assert.equal(parseSlashLine('/workflow off')?.armWorkflow, null);
    assert.equal(parseSlashLine('/wf disarm')?.armWorkflow, null);
    assert.equal(parseSlashLine('/workflow clear')?.armWorkflow, null);
    assert.equal(parseSlashLine('?')?.message, '__help__');
    assert.equal(parseSlashLine('/mcp')?.message, '__mcp_list__');
    assert.equal(parseSlashLine('/mcp list')?.message, '__mcp_list__');
    assert.equal(parseSlashLine('/actions')?.message, '__actions__');
    assert.equal(parseSlashLine('/actions session_x')?.message, '__actions__:session_x');
    assert.equal(parseSlashLine('/transcript')?.message, '__transcript__');
    assert.equal(parseSlashLine('/transcript session_x')?.message, '__transcript__:session_x');
    assert.equal(parseSlashLine('/memory')?.memoryAction?.type, 'status');
    assert.equal(parseSlashLine('/memory init')?.memoryAction?.type, 'init');
    assert.equal(parseSlashLine('/memory show profile')?.memoryAction?.file, 'profile');
    assert.deepEqual(parseSlashLine('/jobs')?.jobsAction, { kind: 'list' });
    assert.deepEqual(parseSlashLine('/jobs status job_abc')?.jobsAction, {
      kind: 'status',
      jobId: 'job_abc',
    });
    assert.deepEqual(parseSlashLine('/jobs tail job_abc')?.jobsAction, {
      kind: 'tail',
      jobId: 'job_abc',
    });
    assert.deepEqual(parseSlashLine('/spawns')?.spawnsAction, { kind: 'list' });
  });

  it('exposes autocomplete items with locale-specific descriptions', () => {
    const zh = slashAutocompleteItems('zh');
    const sessions = zh.find((i) => i.name === 'sessions');
    assert.ok(sessions);
    assert.match(sessions!.description, /会话列表/);
    assert.doesNotMatch(sessions!.description, /Session list/);

    const en = slashAutocompleteItems('en');
    const sessionsEn = en.find((i) => i.name === 'sessions');
    assert.ok(sessionsEn);
    assert.match(sessionsEn!.description, /Session list/);

    const skills = zh.find((i) => i.name === 'skills');
    assert.ok(skills);
    assert.match(skills!.description, /skill/i);

    const workflow = zh.find((i) => i.name === 'workflow');
    assert.ok(workflow);
    assert.match(workflow!.description, /workflow/i);

    const actions = SLASH_HELP_LINES.find((l) => l.includes('/actions'));
    assert.ok(actions);
    assert.match(actions!, /审计当前会话/);

    const transcript = SLASH_HELP_LINES.find((l) => l.includes('/transcript'));
    assert.ok(transcript);
    assert.match(transcript!, /对话时间线/);
    assert.match(transcript!, /conversation timeline/);
    assert.equal(zh.some((i) => i.name === 'session'), false);
    assert.equal(zh.some((i) => i.name === 'actions'), true);
    assert.equal(zh.some((i) => i.name === 'transcript'), true);
    assert.equal(zh.some((i) => i.name === 'brief'), true);
    assert.equal(zh.some((i) => i.name === 'lang'), true);
  });
});