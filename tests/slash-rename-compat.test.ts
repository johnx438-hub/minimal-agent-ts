import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSlashLine } from '../src/tui/slash.js';

describe('slash rename compat', () => {
  it('parses new primary commands', () => {
    assert.equal(parseSlashLine('/actions')?.message, '__actions__');
    assert.equal(parseSlashLine('/actions sid')?.message, '__actions__:sid');
    assert.equal(parseSlashLine('/transcript')?.message, '__transcript__');
    assert.equal(parseSlashLine('/transcript sid')?.message, '__transcript__:sid');
    assert.equal(parseSlashLine('/brief')?.briefWrite, true);
    assert.equal(parseSlashLine('/brief load')?.briefLoad, '');
    assert.equal(parseSlashLine('/brief load sid')?.briefLoad, 'sid');
    assert.equal(parseSlashLine('/new brief')?.newSessionBrief, true);
  });

  it('rejects renamed aliases with guidance', () => {
    assert.match(parseSlashLine('/log')?.message ?? '', /use \/actions/);
    assert.match(parseSlashLine('/history')?.message ?? '', /use \/transcript/);
    assert.match(parseSlashLine('/handoff')?.message ?? '', /use \/brief/);
    assert.match(parseSlashLine('/new handoff')?.message ?? '', /use \/new brief/);
    assert.match(parseSlashLine('/session')?.message ?? '', /use \/sessions/);
    assert.match(parseSlashLine('/provider glm')?.message ?? '', /use \/profile/);
  });
});