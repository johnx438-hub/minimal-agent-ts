import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SessionMessage } from '../src/hooks/message-bridge.js';
import { formatBridgeMessageForTui } from '../src/tui/pi/bridge-sink.js';

describe('formatBridgeMessageForTui', () => {
  it('formats system_notice from job with still_running body', () => {
    const msg: SessionMessage = {
      session_id: 's1',
      turn: 0,
      role: 'system_notice',
      timestamp: 1,
      source: 'job',
      source_id: 'job_abc',
      content:
        '[system_event · not a user message]\nkind: job_complete\nstill_running: 1',
    };
    const text = formatBridgeMessageForTui(msg);
    assert.ok(text);
    assert.match(text!, /📡 job job_abc/);
    assert.match(text!, /not a user message/);
    assert.match(text!, /still_running: 1/);
  });

  it('ignores non-notice roles', () => {
    const msg: SessionMessage = {
      session_id: 's1',
      turn: 1,
      role: 'user',
      timestamp: 1,
      content: 'hello',
      source: 'main',
    };
    assert.equal(formatBridgeMessageForTui(msg), null);
  });

  it('clips long bodies', () => {
    const msg: SessionMessage = {
      session_id: 's1',
      turn: 0,
      role: 'system_notice',
      timestamp: 1,
      source: 'workflow',
      source_id: 'workflow:dag-review',
      content: 'x'.repeat(5000),
    };
    const text = formatBridgeMessageForTui(msg, 100);
    assert.ok(text);
    assert.match(text!, /…$/);
    assert.ok(text!.length < 200);
  });
});
