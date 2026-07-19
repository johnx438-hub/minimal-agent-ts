import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkflowCheckpointInfo } from '../src/workflow-checkpoint.js';
import { createWebWorkflowConfirm } from '../src/web/workflow-confirm.js';
import type { WsHub } from '../src/web/ws-hub.js';

function fakeHub() {
  const frames: unknown[] = [];
  return {
    frames,
    hub: {
      broadcast(payload: unknown) {
        frames.push(payload);
      },
    } as unknown as WsHub,
  };
}

const sample: WorkflowCheckpointInfo = {
  name: 'dag-review',
  path: '/tmp/dag-review.json',
  needsShell: true,
  needsWeb: false,
  roles: [
    { name: 'planner', tools: ['read_file'], needsShell: false, needsWeb: false },
    { name: 'worker', tools: ['run_shell', 'edit_file'], needsShell: true, needsWeb: false },
  ],
};

describe('web workflow confirm', () => {
  it('broadcasts pending and resolves on approve', async () => {
    const { frames, hub } = fakeHub();
    const ctl = createWebWorkflowConfirm(hub);
    const p = ctl.confirmFn(sample);
    assert.equal(ctl.getPending()?.workflow, 'dag-review');
    assert.equal((frames[0] as { type: string; status: string }).type, 'workflow_confirm');
    assert.equal((frames[0] as { status: string }).status, 'pending');
    assert.equal(ctl.respond(true), true);
    assert.equal(await p, true);
    assert.equal(ctl.getPending(), null);
    assert.equal((frames.at(-1) as { status: string }).status, 'approved');
  });

  it('denies and clears pending', async () => {
    const { hub } = fakeHub();
    const ctl = createWebWorkflowConfirm(hub);
    const p = ctl.confirmFn(sample);
    assert.equal(ctl.respond(false), true);
    assert.equal(await p, false);
    assert.equal(ctl.respond(true), false);
  });

  it('aborts via AbortSignal', async () => {
    const { hub } = fakeHub();
    const ctl = createWebWorkflowConfirm(hub);
    const ac = new AbortController();
    const p = ctl.confirmFn(sample, ac.signal);
    ac.abort();
    assert.equal(await p, false);
    assert.equal(ctl.getPending(), null);
  });
});
