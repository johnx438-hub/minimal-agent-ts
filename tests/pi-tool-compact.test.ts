import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatGenericToolFailureLine,
  formatToolBreadcrumb,
  isToolFailure,
  toolDisplayTier,
} from '../src/tui/pi/tool-compact.js';

describe('pi tool compact helpers', () => {
  it('assigns display tiers', () => {
    assert.equal(toolDisplayTier('write_file'), 'rich');
    assert.equal(toolDisplayTier('edit_file'), 'rich');
    assert.equal(toolDisplayTier('run_shell'), 'shell_fold');
    assert.equal(toolDisplayTier('read_file'), 'breadcrumb');
    assert.equal(toolDisplayTier('grep_search'), 'breadcrumb');
  });

  it('detects write, edit, shell, and generic failures', () => {
    assert.equal(isToolFailure('write_file', 'error: permission denied'), true);
    assert.equal(isToolFailure('write_file', 'ok: wrote 3 bytes to a.ts'), false);
    assert.equal(isToolFailure('edit_file', 'error: no match'), true);
    assert.equal(isToolFailure('edit_file', 'ok: edited a.ts'), false);
    assert.equal(isToolFailure('run_shell', 'error: exit 1\n'), true);
    assert.equal(isToolFailure('run_shell', '[shell:ok]\nhello'), false);
    assert.equal(isToolFailure('read_file', 'error: not found'), true);
    assert.equal(isToolFailure('read_file', 'file contents'), false);
    assert.equal(isToolFailure('run_shell', '[aborted]'), true);
  });

  it('formats breadcrumbs without body content', () => {
    const readArgs = '{"path":"src/agent.ts","offset":10,"limit":20}';
    const readOut = 'line10\nline11\n[file_meta hash=abc lines=412]';
    assert.match(formatToolBreadcrumb('read_file', readArgs, readOut), /← read: src\/agent\.ts \(412 lines @L10-29\)/);

    const listOut = 'src/\n  agent.ts\n  tools/\n    registry.ts';
    assert.match(formatToolBreadcrumb('list_files', '{"path":"src"}', listOut), /← list: src \(3 entries\)/);

    const grepOut = 'src/a.ts:1:foo\nsrc/b.ts:2:foo';
    assert.match(
      formatToolBreadcrumb('grep_search', '{"pattern":"foo","path":"src"}', grepOut),
      /← grep: "foo" in src \(2 matches\)/,
    );
    assert.match(
      formatToolBreadcrumb('grep_search', '{"pattern":"nope","path":"."}', '(no matches)'),
      /0 matches/,
    );
  });

  it('formats generic failure lines', () => {
    const line = formatGenericToolFailureLine('read_file', 'error: ENOENT\nmissing');
    assert.match(line, /^✗ read_file: error: ENOENT/);
  });
});