import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildUnifiedLineDiff, diffLineOps } from '../src/tools/line-diff.js';

describe('diffLineOps', () => {
  it('marks deletions and additions', () => {
    const ops = diffLineOps('a\nb', 'a\nc');
    const types = ops.map((o) => o.type);
    assert.deepEqual(types, ['ctx', 'del', 'add']);
    assert.equal(ops[1].line, 'b');
    assert.equal(ops[2].line, 'c');
  });
});

describe('buildUnifiedLineDiff', () => {
  it('interleaves removed and added lines in hunks', () => {
    const diff = buildUnifiedLineDiff({
      path: 'f.ts',
      oldText: 'keep\nold\nold2',
      newText: 'keep\nnew',
    });
    assert.match(diff, /^--- a\/f\.ts\n\+\+\+ b\/f\.ts/m);
    assert.match(diff, /@@ f\.ts @@/);
    assert.match(diff, / keep/);
    assert.match(diff, /- old\n- old2/);
    assert.match(diff, /\+ new/);
  });

  it('labels new files with /dev/null', () => {
    const diff = buildUnifiedLineDiff({
      path: 'new.ts',
      oldText: '',
      newText: 'hello',
      oldLabel: '/dev/null',
      newLabel: 'b/new.ts',
    });
    assert.match(diff, /^--- \/dev\/null\n\+\+\+ b\/new\.ts\n@@ new\.ts @@\n\+ hello$/);
  });
});