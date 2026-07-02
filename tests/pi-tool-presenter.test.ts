import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Component } from '@earendil-works/pi-tui';

import { PiToolPresenter } from '../src/tui/pi/tool-presenter.js';

function createMockPresenter(): {
  presenter: PiToolPresenter;
  textLines: string[];
} {
  const textLines: string[] = [];
  const chat = {
    insertBefore: (_c: Component, _a: Component) => {},
    insertBeforeEditor: (c: Component) => {
      const render = c.render(120);
      textLines.push(...render);
    },
    remove: () => {},
  };
  const tui = { requestRender: () => {} };
  const presenter = new PiToolPresenter({
    chat: chat as never,
    tui: tui as never,
    getAnchor: () => null,
  });
  return { presenter, textLines };
}

describe('PiToolPresenter call_id pairing', () => {
  it('pairs write_file results by call_id when completions are out of order', () => {
    const { presenter, textLines } = createMockPresenter();

    presenter.handleToolCall('call_a', 'write_file', '{"path":"a.ts","content":"aaa"}');
    presenter.handleToolCall('call_b', 'write_file', '{"path":"b.ts","content":"bbb"}');

    textLines.length = 0;
    presenter.handleToolResult(
      'call_b',
      'write_file',
      'ok: wrote 3 bytes to b.ts (new file)',
      '--- /dev/null\n+++ b/b.ts\n+ bbb',
      '{"path":"b.ts","content":"bbb"}',
    );

    const joined = textLines.join('\n');
    assert.match(joined, /b\.ts/);
    assert.doesNotMatch(joined, /← write:.*a\.ts/);
  });

  it('clears shell loader for the matching call_id only', () => {
    const { presenter } = createMockPresenter();

    presenter.handleToolCall('shell_1', 'run_shell', '{"command":"sleep 1"}');
    presenter.handleToolCall('shell_2', 'run_shell', '{"command":"echo hi"}');

    presenter.handleToolResult(
      'shell_2',
      'run_shell',
      'hi',
      undefined,
      '{"command":"echo hi"}',
    );

    presenter.reset();
  });
});