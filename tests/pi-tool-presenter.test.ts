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
    compact: false,
  });
  return { presenter, textLines };
}

function createCompactPresenter(): {
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
    compact: true,
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

describe('PiToolPresenter compact mode', () => {
  it('suppresses successful write_file rendering', () => {
    const { presenter, textLines } = createCompactPresenter();

    presenter.handleToolCall('call_a', 'write_file', '{"path":"a.ts","content":"aaa"}');
    textLines.length = 0;
    presenter.handleToolResult(
      'call_a',
      'write_file',
      'ok: wrote 3 bytes to a.ts (new file)',
      '--- /dev/null\n+++ a/a.ts\n+ aaa',
      '{"path":"a.ts","content":"aaa"}',
    );

    assert.equal(textLines.length, 0);
  });

  it('shows write_file failures in full', () => {
    const { presenter, textLines } = createCompactPresenter();

    presenter.handleToolCall('call_a', 'write_file', '{"path":"a.ts","content":"aaa"}');
    textLines.length = 0;
    presenter.handleToolResult(
      'call_a',
      'write_file',
      'error: permission denied',
      undefined,
      '{"path":"a.ts","content":"aaa"}',
    );

    const joined = textLines.join('\n');
    assert.match(joined, /error/);
    assert.match(joined, /a\.ts/);
  });

  it('suppresses successful shell output but keeps failure detail', () => {
    const { presenter, textLines } = createCompactPresenter();

    presenter.handleToolCall('shell_1', 'run_shell', '{"command":"echo hi"}');
    textLines.length = 0;
    presenter.handleToolResult('shell_1', 'run_shell', '[shell:ok]\nhi', undefined, '{"command":"echo hi"}');
    assert.equal(textLines.length, 0);

    presenter.handleToolCall('shell_2', 'run_shell', '{"command":"false"}');
    textLines.length = 0;
    presenter.handleToolResult(
      'shell_2',
      'run_shell',
      'error: exit 1',
      undefined,
      '{"command":"false"}',
    );
    const joined = textLines.join('\n');
    assert.match(joined, /exit 1|error/i);
  });
});