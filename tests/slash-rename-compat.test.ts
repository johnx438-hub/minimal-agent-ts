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

  it('deprecated aliases still work with hint', () => {
    assert.equal(parseSlashLine('/log')?.message, '__actions__');
    assert.match(parseSlashLine('/log')?.deprecatedSlash ?? '', /deprecated.*\/actions/);
    assert.equal(parseSlashLine('/history')?.message, '__transcript__');
    assert.match(parseSlashLine('/history')?.deprecatedSlash ?? '', /deprecated.*\/transcript/);
    assert.equal(parseSlashLine('/handoff')?.briefWrite, true);
    assert.match(parseSlashLine('/handoff')?.deprecatedSlash ?? '', /deprecated.*\/brief/);
    assert.equal(parseSlashLine('/new handoff')?.newSessionBrief, true);
    assert.match(parseSlashLine('/new handoff')?.deprecatedSlash ?? '', /deprecated.*\/new brief/);
  });

  it('rejects removed aliases with guidance', () => {
    assert.match(parseSlashLine('/session')?.message ?? '', /use \/sessions/);
    assert.match(parseSlashLine('/provider glm')?.message ?? '', /use \/profile/);
  });
});