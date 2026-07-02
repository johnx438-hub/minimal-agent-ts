import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatEditToolResult,
  splitEditToolOutput,
} from '../src/tools/edit-display.js';

describe('formatEditToolResult', () => {
  it('embeds unified diff for search_replace', () => {
    const raw = formatEditToolResult(
      'a.ts',
      10,
      'abc',
      'old line',
      'new line',
      'search_replace',
    );
    const { output, display } = splitEditToolOutput(raw);
    assert.equal(output, 'ok: edited a.ts (10 bytes) file_hash=abc');
    assert.match(display ?? '', /- old line/);
    assert.match(display ?? '', /\+ new line/);
  });

  it('shows removed line_range snippet', () => {
    const raw = formatEditToolResult(
      'b.ts',
      20,
      'def',
      'rm1\nrm2',
      'add1',
      'line_range',
    );
    const { display } = splitEditToolOutput(raw);
    assert.match(display ?? '', /- rm1/);
    assert.match(display ?? '', /- rm2/);
    assert.match(display ?? '', /\+ add1/);
  });
});