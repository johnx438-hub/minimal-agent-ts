import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildEditDiffText,
  buildEditDisplayParts,
  editStatusFromOutput,
  formatEditCallLineFromArgs,
  formatEditResultMarkdown,
  formatEditSummaryLine,
  parseEditArgs,
} from '../src/tui/pi/edit-display.js';

describe('parseEditArgs', () => {
  it('parses search_replace mode', () => {
    const parsed = parseEditArgs(
      '{"path":"src/a.ts","old_string":"foo","new_string":"bar"}',
    );
    assert.equal(parsed.path, 'src/a.ts');
    assert.equal(parsed.mode, 'search_replace');
    assert.equal(parsed.oldString, 'foo');
    assert.equal(parsed.newString, 'bar');
  });

  it('parses line_range mode', () => {
    const parsed = parseEditArgs(
      '{"path":"b.ts","start_line":3,"end_line":5,"new_content":"x\\ny"}',
    );
    assert.equal(parsed.mode, 'line_range');
    assert.equal(parsed.startLine, 3);
    assert.equal(parsed.endLine, 5);
    assert.equal(parsed.newContent, 'x\ny');
  });
});

describe('buildEditDiffText', () => {
  it('renders old and new lines for search_replace (fallback)', () => {
    const parsed = parseEditArgs(
      '{"path":"f.ts","old_string":"a\\nb","new_string":"c"}',
    );
    const diff = buildEditDiffText(parsed);
    assert.match(diff, /- a/);
    assert.match(diff, /- b/);
    assert.match(diff, /\+ c/);
  });

  it('notes replace_all in search_replace header', () => {
    const parsed = parseEditArgs(
      '{"path":"f.ts","old_string":"x","new_string":"y","replace_all":true}',
    );
    assert.match(buildEditDiffText(parsed), /^--- f\.ts \(replace_all\)/);
  });

  it('renders line_range with removed placeholder and new lines', () => {
    const parsed = parseEditArgs(
      '{"path":"f.ts","start_line":10,"end_line":12,"new_content":"new1\\nnew2"}',
    );
    const diff = buildEditDiffText(parsed);
    assert.match(diff, /@@ f\.ts:10-12 @@/);
    assert.match(diff, /- <3 line\(s\) removed>/);
    assert.match(diff, /\+ new1\n\+ new2/);
  });
});

describe('buildEditDisplayParts', () => {
  it('prefers tool display payload over args fallback', () => {
    const args = '{"path":"x.ts","old_string":"1","new_string":"2"}';
    const out = 'ok: edited x.ts (42 bytes) file_hash=deadbeef';
    const display = '--- a/x.ts\n+++ b/x.ts\n@@ x.ts @@\n- 1\n+ 2';
    const parts = buildEditDisplayParts(args, out, display);
    assert.equal(parts.status, 'ok');
    assert.equal(parts.fileHash, 'deadbeef');
    assert.equal(parts.diffText, display);
  });

  it('builds error parts without diff', () => {
    const args = '{"path":"x.ts","old_string":"missing","new_string":"2"}';
    const out = 'error: old_string not found in x.ts';
    const parts = buildEditDisplayParts(args, out);
    assert.equal(parts.status, 'error');
    assert.equal(parts.diffText, '');
    assert.equal(parts.errorBody, out);
  });
});

describe('editStatusFromOutput', () => {
  it('detects ok and error', () => {
    assert.equal(editStatusFromOutput('ok: edited a'), 'ok');
    assert.equal(editStatusFromOutput('error: stale file'), 'error');
  });
});

describe('formatEditResultMarkdown', () => {
  it('wraps diff in a fenced diff block', () => {
    const parts = buildEditDisplayParts(
      '{"path":"m.ts","old_string":"a","new_string":"b"}',
      'ok: edited m.ts (1 bytes) file_hash=abc',
    );
    const md = formatEditResultMarkdown(parts);
    assert.match(md, /\*\*edit\*\* `m\.ts` \(search_replace\)/);
    assert.match(md, /```diff\n--- m\.ts\n/);
  });

  it('shows error body for failures', () => {
    const parts = buildEditDisplayParts(
      '{"path":"m.ts","old_string":"a","new_string":"b"}',
      'error: hash mismatch',
    );
    const md = formatEditResultMarkdown(parts);
    assert.match(md, /```text\nerror: hash mismatch\n```/);
  });
});

describe('formatEditCallLineFromArgs', () => {
  it('includes path and mode', () => {
    const line = formatEditCallLineFromArgs(
      parseEditArgs('{"path":"src/foo.ts","old_string":"a","new_string":"b"}'),
    );
    assert.equal(line, '→ edit: src/foo.ts (search_replace)');
  });
});

describe('formatEditSummaryLine', () => {
  it('truncates long error messages', () => {
    const parts = buildEditDisplayParts(
      '{"path":"long/path.ts","old_string":"a","new_string":"b"}',
      'error: ' + 'x'.repeat(200),
    );
    const line = formatEditSummaryLine(parts);
    assert.match(line, /^← edit: error, long\/path\.ts — error: /);
    assert.ok(line.length < 200);
  });
});