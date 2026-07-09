import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildShellDisplayParts,
  formatShellCallLine,
  formatShellResultMarkdown,
  formatShellSummaryLine,
  parseShellCommand,
  shellStatusFromOutput,
  splitShellOutput,
} from '../src/tui/pi/shell-display.js';

describe('parseShellCommand', () => {
  it('extracts command from args JSON', () => {
    assert.equal(
      parseShellCommand('{"command":"npm test","timeout_ms":5000}'),
      'npm test',
    );
  });

  it('returns empty string for invalid JSON', () => {
    assert.equal(parseShellCommand('not-json'), '');
  });

  it('decodes command_b64 for display', () => {
    const cmd = 'opencli hotlist --site hn';
    const b64 = Buffer.from(cmd, 'utf8').toString('base64');
    assert.equal(parseShellCommand(JSON.stringify({ command_b64: b64 })), cmd);
  });

  it('prefers command_b64 over plain command', () => {
    const cmd = 'echo "real"';
    const b64 = Buffer.from(cmd, 'utf8').toString('base64');
    assert.equal(
      parseShellCommand(JSON.stringify({ command: 'wrong', command_b64: b64 })),
      cmd,
    );
  });
});

describe('splitShellOutput', () => {
  it('splits shell meta prefix from body', () => {
    const out = '[shell: elapsed=2s, timeout_ms=30000]\nline one\nline two';
    assert.deepEqual(splitShellOutput(out), {
      meta: '[shell: elapsed=2s, timeout_ms=30000]',
      body: 'line one\nline two',
    });
  });

  it('keeps plain output as body', () => {
    assert.deepEqual(splitShellOutput('hello\nworld'), { body: 'hello\nworld' });
  });
});

describe('shellStatusFromOutput', () => {
  it('detects exit code errors', () => {
    assert.equal(shellStatusFromOutput('error: exit 1\nfailed'), 'exit 1');
  });

  it('detects timeout', () => {
    assert.equal(shellStatusFromOutput('error: command timed out after 30s'), 'timeout');
  });

  it('treats clean output as ok', () => {
    assert.equal(shellStatusFromOutput('all good'), 'ok');
  });
});

describe('formatShellResultMarkdown', () => {
  it('renders command and fenced body on separate blocks', () => {
    const parts = buildShellDisplayParts(
      '{"command":"echo hi"}',
      'hello\nworld',
    );
    const md = formatShellResultMarkdown(parts);
    assert.match(md, /\*\*\$\*\* `echo hi`/);
    assert.match(md, /```console\nhello\nworld\n```/);
  });

  it('uses wider fence when body contains triple backticks', () => {
    const parts = buildShellDisplayParts(
      '{"command":"cat"}',
      '````\nodd\n````',
    );
    const md = formatShellResultMarkdown(parts);
    assert.match(md, /`````console/);
  });
});

describe('formatShellCallLine', () => {
  it('prefixes with arrow and dollar prompt', () => {
    assert.equal(formatShellCallLine('ls -la'), '→ shell: $ ls -la');
  });
});

describe('formatShellSummaryLine', () => {
  it('includes status, command, and meta', () => {
    const parts = buildShellDisplayParts(
      '{"command":"false"}',
      '[shell: elapsed=1s]\nerror: exit 1\nboom',
    );
    const line = formatShellSummaryLine(parts);
    assert.match(line, /^← shell: exit 1, \$ false/);
    assert.match(line, /\[shell: elapsed=1s\]/);
  });
});