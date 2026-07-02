import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildWriteDiff,
  formatWriteToolResult,
  parseWriteKind,
  splitWriteToolOutput,
  writeStatusFromOutput,
} from '../src/tools/write-display.js';

describe('buildWriteDiff', () => {
  it('shows all lines as added for a new file', () => {
    const diff = buildWriteDiff('new.ts', null, 'a\nb');
    assert.match(diff, /^--- \/dev\/null\n\+\+\+ b\/new\.ts/);
    assert.match(diff, /\+ a\n\+ b$/);
  });

  it('shows removed and added lines on overwrite', () => {
    const diff = buildWriteDiff('f.ts', 'old\nline', 'new');
    assert.match(diff, /^--- a\/f\.ts\n\+\+\+ b\/f\.ts/m);
    assert.match(diff, /- old/);
    assert.match(diff, /- line/);
    assert.match(diff, /\+ new/);
  });
});

describe('formatWriteToolResult', () => {
  it('embeds display block after a short summary', () => {
    const raw = formatWriteToolResult('x.ts', 3, null, 'abc');
    assert.match(raw, /^ok: wrote 3 bytes to x\.ts \(new file\)/);
    const { output, display } = splitWriteToolOutput(raw);
    assert.equal(output, 'ok: wrote 3 bytes to x.ts (new file)');
    assert.match(display ?? '', /\+\+\+ b\/x\.ts/);
    assert.match(display ?? '', /\+ abc/);
  });

  it('labels overwrite files', () => {
    const raw = formatWriteToolResult('x.ts', 2, 'a', 'bb');
    assert.match(raw, /\(overwrite\)/);
    const { output } = splitWriteToolOutput(raw);
    assert.equal(output, 'ok: wrote 2 bytes to x.ts (overwrite)');
  });
});

describe('splitWriteToolOutput', () => {
  it('returns raw output when no display markers exist', () => {
    assert.deepEqual(splitWriteToolOutput('ok: wrote 1 bytes to a'), {
      output: 'ok: wrote 1 bytes to a',
    });
  });
});

describe('writeStatusFromOutput', () => {
  it('detects ok and error', () => {
    assert.equal(writeStatusFromOutput('ok: wrote 1 bytes to a (new file)'), 'ok');
    assert.equal(writeStatusFromOutput('error: cannot read a'), 'error');
  });
});

describe('parseWriteKind', () => {
  it('parses new file and overwrite labels', () => {
    assert.equal(parseWriteKind('ok: wrote 1 bytes to a (new file)'), 'new file');
    assert.equal(parseWriteKind('ok: wrote 1 bytes to a (overwrite)'), 'overwrite');
  });
});