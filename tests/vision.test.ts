import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { assembleApiMessages } from '../src/context/assemble.js';
import type { ChatMessage } from '../src/types.js';
import {
  getMessageText,
  materializeVisionMessage,
  visionRefFromPath,
  visionRefFromUrl,
} from '../src/vision.js';
import { configureSessionStore, resetWorkspaceForTests } from '../src/workspace.js';

/** Minimal 1×1 PNG */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('vision materialize', () => {
  it('materializes local png to data URL parts', () => {
    resetWorkspaceForTests();
    const dir = mkdtempSync(join(tmpdir(), 'vis-'));
    configureSessionStore({ mode: 'project_local', cwd: dir });
    const img = join(dir, 'dot.png');
    writeFileSync(img, TINY_PNG);

    const msg: ChatMessage = {
      role: 'user',
      content: 'what color?',
      vision_refs: [visionRefFromPath(img)],
    };
    const out = materializeVisionMessage(msg, { cwd: dir });
    assert.ok(Array.isArray(out.content));
    const parts = out.content as { type: string; text?: string; image_url?: { url: string } }[];
    assert.equal(parts[0]?.type, 'text');
    assert.match(parts[0]!.text!, /what color/);
    assert.equal(parts[1]?.type, 'image_url');
    assert.match(parts[1]!.image_url!.url, /^data:image\/png;base64,/);
    assert.equal(out.vision_refs, undefined);
  });

  it('degrades remote url when allow_remote_url false', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: 'see',
      vision_refs: [visionRefFromUrl('https://example.com/a.png')],
    };
    const out = materializeVisionMessage(msg, {
      cwd: process.cwd(),
      policy: { allow_remote_url: false, materialize_fail: 'degrade' },
    });
    const parts = out.content as { type: string; text?: string }[];
    assert.ok(parts.some((p) => p.type === 'text' && /load failed|disabled/i.test(p.text ?? '')));
  });

  it('allows https remote when enabled', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: 'see',
      vision_refs: [visionRefFromUrl('https://example.com/a.png')],
    };
    const out = materializeVisionMessage(msg, {
      cwd: process.cwd(),
      policy: { allow_remote_url: true },
    });
    const parts = out.content as { type: string; image_url?: { url: string } }[];
    assert.equal(parts[1]?.type, 'image_url');
    assert.equal(parts[1]?.image_url?.url, 'https://example.com/a.png');
  });

  it('assembleApiMessages strips vision_refs and materializes', () => {
    resetWorkspaceForTests();
    const dir = mkdtempSync(join(tmpdir(), 'vis2-'));
    configureSessionStore({ mode: 'project_local', cwd: dir });
    const img = join(dir, 'dot.png');
    writeFileSync(img, TINY_PNG);

    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: 'hi',
        vision_refs: [visionRefFromPath('dot.png')],
        action_id: 'should-strip',
      },
    ];
    const api = assembleApiMessages(messages, { cwd: dir });
    const user = api.find((m) => m.role === 'user')!;
    assert.equal(user.vision_refs, undefined);
    assert.equal((user as { action_id?: string }).action_id, undefined);
    assert.ok(Array.isArray(user.content));
  });

  it('getMessageText works for string and parts', () => {
    assert.equal(getMessageText('abc'), 'abc');
    assert.equal(
      getMessageText([
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: { url: 'data:x' } },
        { type: 'text', text: 'b' },
      ]),
      'a\nb',
    );
  });
});
