import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWebPermissionConfirm } from '../src/web/permission-confirm.js';
import type { WsHub } from '../src/web/ws-hub.js';

function mockHub() {
  const frames: unknown[] = [];
  return {
    frames,
    hub: {
      broadcast(frame: unknown) {
        frames.push(frame);
      },
    } as unknown as WsHub,
  };
}

describe('createWebPermissionConfirm', () => {
  it('auto-denies shell and web without broadcasting', async () => {
    const { frames, hub } = mockHub();
    const gate = createWebPermissionConfirm(hub);
    const shell = await gate.prompter({
      kind: 'shell',
      reason: 'run_shell',
    });
    const web = await gate.prompter({ kind: 'web', reason: 'web_fetch' });
    assert.equal(shell, 'deny');
    assert.equal(web, 'deny');
    assert.equal(frames.length, 0);
  });

  it('broadcasts path_escape pending and resolves session', async () => {
    const { frames, hub } = mockHub();
    const gate = createWebPermissionConfirm(hub);
    const p = gate.prompter({
      kind: 'path_escape',
      reason: 'read_file: /tmp/x',
    });
    assert.equal(frames.length, 1);
    const pending = frames[0] as { type: string; status: string; kind: string };
    assert.equal(pending.type, 'permission_confirm');
    assert.equal(pending.status, 'pending');
    assert.equal(pending.kind, 'path_escape');

    assert.equal(gate.respond('session'), true);
    const choice = await p;
    assert.equal(choice, 'session');
    const last = frames[frames.length - 1] as {
      status: string;
      choice: string;
    };
    assert.equal(last.status, 'approved');
    assert.equal(last.choice, 'session');
  });

  it('deny resolves to deny', async () => {
    const { hub } = mockHub();
    const gate = createWebPermissionConfirm(hub);
    const p = gate.prompter({
      kind: 'path_escape',
      reason: 'read /etc/passwd',
    });
    assert.equal(gate.respond('deny'), true);
    assert.equal(await p, 'deny');
  });
});
