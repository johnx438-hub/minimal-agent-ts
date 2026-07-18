import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';

import {
  checkToken,
  extractRequestToken,
  generateWebUiToken,
  resolveWebUiToken,
} from '../src/web/auth.js';
import { createWsMessageSink } from '../src/web/ws-sink.js';
import { WsHub } from '../src/web/ws-hub.js';
import { safeJoin } from '../src/web/static.js';
import { resolve } from 'node:path';

describe('web ui auth', () => {
  it('generates non-empty tokens', () => {
    const a = generateWebUiToken();
    const b = generateWebUiToken();
    assert.ok(a.length >= 16);
    assert.notEqual(a, b);
  });

  it('resolveWebUiToken prefers explicit then env', () => {
    assert.equal(resolveWebUiToken('fixed-token'), 'fixed-token');
  });

  it('checkToken rejects missing and mismatch', () => {
    const t = generateWebUiToken();
    assert.equal(checkToken(undefined, t), false);
    assert.equal(checkToken('wrong', t), false);
    assert.equal(checkToken(t, t), true);
  });

  it('extractRequestToken reads bearer and query', () => {
    const url = new URL('http://127.0.0.1:7788/v1/task?token=qtok');
    const req = {
      headers: { authorization: 'Bearer bear' },
    } as IncomingMessage;
    assert.equal(extractRequestToken(req, url), 'bear');
    const req2 = { headers: {} } as IncomingMessage;
    assert.equal(extractRequestToken(req2, url), 'qtok');
  });
});

describe('web ui ws sink', () => {
  it('broadcasts SessionMessage without throwing', () => {
    const hub = new WsHub();
    const sent: string[] = [];
    // Fake client
    const fake = {
      readyState: 1,
      OPEN: 1,
      send(data: string) {
        sent.push(data);
      },
      on() {},
    };
    hub.add(fake as never);
    const sink = createWsMessageSink(hub);
    sink.onMessage({
      session_id: 's1',
      turn: 1,
      role: 'assistant',
      content: 'hi',
      timestamp: Date.now(),
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /"content":"hi"/);
  });
});

describe('web ui static path safety', () => {
  it('rejects path escape', () => {
    const root = resolve('/tmp/web-ui-root');
    assert.equal(safeJoin(root, '../etc/passwd'), null);
    assert.ok(safeJoin(root, 'index.html')?.endsWith('index.html'));
  });
});

describe('web ui command dispatch', () => {
  it('dispatches /help without runtime side effects', async () => {
    const { dispatchWebCommand } = await import('../src/slash/index.js');
    const hub = { broadcast() {} };
    const runtime = {
      isRunning: () => false,
      listSessionProfileChoices: () => [],
      listSessionModelChoices: () => [],
      listWorkflowMeta: () => [],
      listSkills: () => [],
      getLoadedSkills: () => [],
      getArmedWorkflow: () => null,
    };
    const r = dispatchWebCommand('/help', runtime as never, hub as never);
    assert.equal(r.ok, true);
    assert.match(r.message || '', /Web slash|profile|workflow/i);
  });
});

describe('web ui event bridge', () => {
  it('maps runtime events to control frames', async () => {
    const { attachRuntimeEventBridge } = await import('../src/web/event-bridge.js');
    const { WsHub } = await import('../src/web/ws-hub.js');
    const frames: unknown[] = [];
    const hub = new WsHub();
    const fake = {
      readyState: 1,
      OPEN: 1,
      send(data: string) {
        frames.push(JSON.parse(data));
      },
      on() {},
    };
    hub.add(fake as never);

    const listeners = new Set<(e: unknown) => void>();
    const runtime = {
      onEvent(fn: (e: unknown) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const unsub = attachRuntimeEventBridge(runtime as never, hub);
    for (const fn of listeners) {
      fn({ type: 'run_start', session_id: 's1', cwd: '/', llm: { model: 'm', profile: 'p' } });
      fn({
        type: 'workflow_step',
        phase: 'dag',
        role: 'worker',
        nodeId: 'impl',
        as: 'worker',
      });
      fn({ type: 'run_end', reason: 'completed' });
    }
    unsub();
    const types = frames.map((f) => (f as { type: string }).type);
    assert.ok(types.includes('run_state'));
    assert.ok(types.includes('workflow_step'));
    assert.equal(
      (frames.find((f) => (f as { type: string }).type === 'workflow_step') as { nodeId?: string })
        .nodeId,
      'impl',
    );
  });
});
