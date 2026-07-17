import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  composeVisionSubmit,
  formatImagePlaceholders,
  formatUserVisionDisplay,
  isLikelyImagePath,
  mergeVisionRefs,
  parseAtImageMentions,
  PendingVisionBuffer,
  visionRefFromUserToken,
} from '../src/tui/vision-input.js';
import { parseSlashLine } from '../src/tui/slash.js';
import { visionRefFromPath } from '../src/vision.js';

describe('tui vision-input', () => {
  it('detects image paths and https urls', () => {
    assert.equal(isLikelyImagePath('./a.png'), true);
    assert.equal(isLikelyImagePath('shot.JPEG'), true);
    assert.equal(isLikelyImagePath('https://cdn.example/x.webp'), true);
    assert.equal(isLikelyImagePath('@user'), false);
    assert.equal(isLikelyImagePath('readme.md'), false);
  });

  it('parses @image mentions and strips them from text', () => {
    const p = parseAtImageMentions(
      '看看这张图的布局 @./shot.png 有没有重叠',
    );
    assert.equal(p.text, '看看这张图的布局 有没有重叠');
    assert.equal(p.refs.length, 1);
    assert.equal(p.refs[0]!.path, './shot.png');
    assert.equal(p.tokens[0], './shot.png');
  });

  it('parses @image after CJK without space', () => {
    const p = parseAtImageMentions('布局@./shot.png有重叠');
    assert.equal(p.refs.length, 1);
    assert.equal(p.refs[0]!.path, './shot.png');
    assert.match(p.text, /布局/);
    assert.match(p.text, /有重叠/);
  });

  it('keeps non-image @tokens in text', () => {
    const p = parseAtImageMentions('ping @alice and @bob.md');
    assert.match(p.text, /@alice/);
    assert.match(p.text, /@bob\.md/);
    assert.equal(p.refs.length, 0);
  });

  it('supports quoted paths with spaces', () => {
    const p = parseAtImageMentions('see @"my shot.png" please');
    assert.equal(p.refs.length, 1);
    assert.equal(p.refs[0]!.path, 'my shot.png');
    assert.equal(p.text, 'see please');
  });

  it('parses multiple images', () => {
    const p = parseAtImageMentions('a @a.png b @b.jpg c');
    assert.equal(p.refs.length, 2);
    assert.equal(p.text, 'a b c');
  });

  it('formats chat placeholders', () => {
    const refs = [visionRefFromPath('x.png')];
    assert.equal(formatImagePlaceholders(refs), '[image: x.png]');
    assert.equal(
      formatUserVisionDisplay('caption', refs),
      'caption\n[image: x.png]',
    );
    assert.equal(formatUserVisionDisplay('', refs), '[image: x.png]');
  });

  it('merges and dedups refs', () => {
    const a = visionRefFromPath('a.png');
    const b = visionRefFromPath('a.png');
    const c = visionRefFromPath('c.png');
    const m = mergeVisionRefs([a], [b, c]);
    assert.equal(m.length, 2);
    assert.equal(m[0]!.path, 'a.png');
    assert.equal(m[1]!.path, 'c.png');
  });

  it('PendingVisionBuffer queues and drains', () => {
    const buf = new PendingVisionBuffer(2);
    assert.equal(buf.add('a.png'), null);
    assert.equal(buf.add('a.png'), null); // dedup
    assert.equal(buf.length, 1);
    assert.equal(buf.add('not-an-image.txt') !== null, true);
    assert.equal(buf.add('b.jpg'), null);
    assert.match(buf.add('c.webp')!, /full/);
    const taken = buf.take();
    assert.equal(taken.length, 2);
    assert.equal(buf.length, 0);
  });

  it('composeVisionSubmit merges pending + @mentions', () => {
    const out = composeVisionSubmit('layout @./ui.png ok', [
      visionRefFromPath('pending.png'),
    ]);
    assert.equal(out.text, 'layout ok');
    assert.equal(out.refs.length, 2);
    assert.match(out.display, /\[image: pending\.png\]/);
    assert.match(out.display, /\[image: \.\/ui\.png\]/);
  });

  it('visionRefFromUserToken builds path and url refs', () => {
    assert.equal(visionRefFromUserToken('x.png')?.path, 'x.png');
    assert.equal(
      visionRefFromUserToken('https://e.com/a.png')?.remote_url,
      'https://e.com/a.png',
    );
    assert.equal(visionRefFromUserToken('note.txt'), null);
  });
});

describe('slash /image', () => {
  it('parses /image add|list|clear', () => {
    assert.deepEqual(parseSlashLine('/image shot.png')?.imageAction, {
      kind: 'add',
      path: 'shot.png',
    });
    assert.deepEqual(parseSlashLine('/img ./a.png')?.imageAction, {
      kind: 'add',
      path: './a.png',
    });
    assert.deepEqual(parseSlashLine('/image list')?.imageAction, {
      kind: 'list',
    });
    assert.deepEqual(parseSlashLine('/image clear')?.imageAction, {
      kind: 'clear',
    });
    assert.match(parseSlashLine('/image')?.message ?? '', /Usage/);
  });

  it('joins paths with spaces', () => {
    assert.deepEqual(parseSlashLine('/image my shot.png')?.imageAction, {
      kind: 'add',
      path: 'my shot.png',
    });
  });
});
