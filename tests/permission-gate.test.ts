import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PermissionGate } from '../src/permission-gate.js';
import type { AgentConfig } from '../src/types.js';

function testConfig(signal?: AbortSignal): AgentConfig {
  return {
    apiKey: 'test',
    baseUrl: 'http://localhost',
    model: 'test-model',
    cwd: '/tmp',
    allowShell: false,
    allowWeb: false,
    abortSignal: signal,
  };
}

describe('PermissionGate abort', () => {
  it('returns false without prompting when already aborted', async () => {
    const gate = new PermissionGate();
    let prompted = false;
    gate.setPrompter(async () => {
      prompted = true;
      return 'once';
    });

    const controller = new AbortController();
    controller.abort();
    const ok = await gate.ensureShell(testConfig(controller.signal), 'run_shell');

    assert.equal(ok, false);
    assert.equal(prompted, false);
  });

  it('emits permission_prompt lifecycle events', async () => {
    const gate = new PermissionGate();
    const events: string[] = [];
    gate.setLifecycle((event) => {
      events.push(`${event.type}:${event.kind}:${'reason' in event && 'approved' in event ? event.reason : event.reason}`);
    });
    gate.setPrompter(async () => 'once');

    const ok = await gate.ensureShell(testConfig(), 'run_shell');

    assert.equal(ok, true);
    assert.deepEqual(events, [
      'permission_prompt_start:shell:run_shell',
      'permission_prompt_end:shell:approved',
    ]);
  });

  it('emits aborted permission_prompt_end when signal aborts during prompt', async () => {
    const gate = new PermissionGate();
    const events: string[] = [];
    gate.setLifecycle((event) => {
      if (event.type === 'permission_prompt_end') {
        events.push(event.reason);
      }
    });
    const controller = new AbortController();
    gate.setPrompter(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('session'), 200);
        }),
    );

    const pending = gate.ensureWeb(testConfig(controller.signal), 'web_fetch');
    controller.abort();
    await pending;

    assert.deepEqual(events, ['aborted']);
  });

  it('resolves deny when abort fires during prompt', async () => {
    const gate = new PermissionGate();
    const controller = new AbortController();

    gate.setPrompter(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('session'), 200);
        }),
    );

    const pending = gate.ensureWeb(testConfig(controller.signal), 'web_fetch');
    controller.abort();
    const ok = await pending;

    assert.equal(ok, false);
  });
});