import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildWriteDisplayParts,
  formatWriteCallLine,
  formatWriteResultMarkdown,
  formatWriteSummaryLine,
} from '../src/tui/pi/write-display.js';

describe('formatWriteCallLine', () => {
  it('shows path and payload size', () => {
    const line = formatWriteCallLine('{"path":"src/a.ts","content":"hello"}');
    assert.equal(line, '→ write: src/a.ts, 5 bytes');
  });
});

describe('buildWriteDisplayParts', () => {
  it('uses display diff for successful writes', () => {
    const parts = buildWriteDisplayParts(
      '{"path":"m.ts","content":"x"}',
      'ok: wrote 1 bytes to m.ts (new file)',
      '--- /dev/null\n+++ m.ts\n+ x',
    );
    assert.equal(parts.status, 'ok');
    assert.equal(parts.kind, 'new file');
    assert.match(parts.diffText, /\+\+\+ m\.ts/);
  });

  it('handles errors without diff', () => {
    const parts = buildWriteDisplayParts(
      '{"path":"m.ts"}',
      'error: cannot read m.ts: denied',
    );
    assert.equal(parts.status, 'error');
    assert.equal(parts.diffText, '');
  });
});

describe('formatWriteResultMarkdown', () => {
  it('wraps diff in a fenced block', () => {
    const parts = buildWriteDisplayParts(
      '{"path":"m.ts"}',
      'ok: wrote 2 bytes to m.ts (overwrite)',
      '--- m.ts\n+++ m.ts\n- a\n+ b',
    );
    const md = formatWriteResultMarkdown(parts);
    assert.match(md, /\*\*write\*\* `m\.ts` \(overwrite\)/);
    assert.match(md, /```diff\n--- m\.ts/);
  });
});

describe('formatWriteSummaryLine', () => {
  it('summarizes successful writes', () => {
    const parts = buildWriteDisplayParts(
      '{"path":"dir/file.ts"}',
      'ok: wrote 99 bytes to dir/file.ts (overwrite)',
      'diff',
    );
    assert.equal(
      formatWriteSummaryLine(parts),
      '← write: 99 bytes, dir/file.ts, overwrite',
    );
  });
});