import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatGenericToolFailureLine,
  formatTurnToolFlushLine,
  isToolFailure,
} from '../src/tui/pi/tool-compact.js';

describe('pi tool compact helpers', () => {
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

  it('formats turn flush lines', () => {
    assert.equal(formatTurnToolFlushLine(0), null);
    assert.equal(formatTurnToolFlushLine(1), '✓ 1 tool call finished');
    assert.equal(formatTurnToolFlushLine(3), '✓ 3 tool calls finished');
  });

  it('formats generic failure lines', () => {
    const line = formatGenericToolFailureLine('read_file', 'error: ENOENT\nmissing');
    assert.match(line, /^✗ read_file: error: ENOENT/);
  });
});