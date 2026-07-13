import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildActionBlock,
  saveAction,
} from '../src/action-store.js';
import {
  configureActionWriteQueue,
  resetActionWriteQueueForTests,
} from '../src/action-write-queue.js';
import {
  materializePriorTurnTools,
  POINTER_RULES,
  shouldPointerize,
} from '../src/pointerize.js';
import type { ChatMessage } from '../src/types.js';
import { setWorkspaceRoot } from '../src/workspace.js';

function chars(n: number): string {
  return 'x'.repeat(n);
}

function lines(n: number, lineLen = 10): string {
  return Array.from({ length: n }, (_, i) => `line${i}:${'a'.repeat(lineLen)}`).join('\n');
}

describe('shouldPointerize', () => {
  it('rejects empty and whitespace-only output', () => {
    assert.equal(shouldPointerize('read_file', ''), false);
    assert.equal(shouldPointerize('read_file', '   \n  '), false);
  });

  it('rejects immune prefixes even when output is large', () => {
    const huge = chars(2000);
    assert.equal(shouldPointerize('read_file', `error: ${huge}`), false);
    assert.equal(shouldPointerize('write_file', `ok: wrote ${huge}`), false);
    assert.equal(shouldPointerize('edit_file', `ok: edited ${huge}`), false);
  });

  it('never pointerizes write_file, edit_file, or apply_patch', () => {
    assert.equal(shouldPointerize('write_file', chars(5000)), false);
    assert.equal(shouldPointerize('edit_file', lines(100)), false);
    assert.equal(shouldPointerize('apply_patch', chars(5000)), false);
  });

  it('uses 400-char default for unknown tools', () => {
    assert.equal(shouldPointerize('custom_tool', chars(400)), false);
    assert.equal(shouldPointerize('custom_tool', chars(401)), true);
  });

  for (const [tool, rule] of Object.entries(POINTER_RULES)) {
    if (
      tool === 'write_file' ||
      tool === 'edit_file' ||
      tool === 'apply_patch' ||
      !Number.isFinite(rule.minChars)
    ) {
      continue;
    }

    it(`applies ${tool} minChars threshold`, () => {
      assert.equal(shouldPointerize(tool, chars(rule.minChars - 1)), false);
      assert.equal(shouldPointerize(tool, chars(rule.minChars)), true);
    });

    if (rule.alwaysIfLines) {
      it(`applies ${tool} alwaysIfLines threshold`, () => {
        const below = lines(rule.alwaysIfLines - 1, 5);
        const at = lines(rule.alwaysIfLines, 5);
        assert.equal(shouldPointerize(tool, below), false);
        assert.equal(shouldPointerize(tool, at), true);
      });
    }
  }
});

describe('materializePriorTurnTools', () => {
  function setupWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ma-pointerize-'));
    setWorkspaceRoot(dir);
    resetActionWriteQueueForTests();
    configureActionWriteQueue({ sync: true });
    return dir;
  }

  function saveLargeReadAction(actionId: string, resultText: string): void {
    saveAction(
      buildActionBlock({
        action_id: actionId,
        task_id: 'task_ptr',
        session_id: 'session_ptr',
        turn_number: 1,
        tool_name: 'read_file',
        args_json: '{"path":"src/a.ts"}',
        result_text: resultText,
      }),
    );
  }

  it('replaces eligible prior-turn tool bodies with pointer cards', () => {
    setupWorkspace();
    const body = chars(800);
    saveLargeReadAction('action_ptr_1', body);

    const msg: ChatMessage = {
      role: 'tool',
      content: body,
      action_id: 'action_ptr_1',
      turn: 1,
    };

    materializePriorTurnTools([msg], 5);

    assert.equal(msg.pointerized, true);
    assert.match(msg.content ?? '', /^\[action:action_ptr_1\]/);
    assert.match(msg.content ?? '', /tool=read_file/);
    assert.match(msg.content ?? '', /path=src\/a\.ts/);
    assert.match(msg.content ?? '', /recall=recall_query\(action_id="action_ptr_1"\)/);
  });

  it('keeps recent turns inline per keepInlineTurns', () => {
    setupWorkspace();
    const body = chars(800);
    saveLargeReadAction('action_ptr_2', body);

    const msg: ChatMessage = {
      role: 'tool',
      content: body,
      action_id: 'action_ptr_2',
      turn: 2,
    };

    materializePriorTurnTools([msg], 4, { keepInlineTurns: 2 });

    assert.equal(msg.pointerized, undefined);
    assert.equal(msg.content, body);
  });

  it('skips already pointerized messages and missing actions', () => {
    setupWorkspace();
    const body = chars(800);
    saveLargeReadAction('action_ptr_3', body);

    const already: ChatMessage = {
      role: 'tool',
      content: '[action:action_ptr_3]',
      action_id: 'action_ptr_3',
      pointerized: true,
      turn: 1,
    };
    const missing: ChatMessage = {
      role: 'tool',
      content: body,
      action_id: 'action_missing',
      turn: 1,
    };

    materializePriorTurnTools([already, missing], 5);

    assert.equal(already.content, '[action:action_ptr_3]');
    assert.equal(missing.content, body);
    assert.equal(missing.pointerized, undefined);
  });

  it('marks truncated inline bodies on the pointer card', () => {
    setupWorkspace();
    const body = chars(800);
    saveLargeReadAction('action_ptr_4', body);

    const msg: ChatMessage = {
      role: 'tool',
      content: `${body}...(truncated)`,
      action_id: 'action_ptr_4',
      turn: 1,
    };

    materializePriorTurnTools([msg], 5);

    assert.equal(msg.pointerized, true);
    assert.match(msg.content ?? '', /stored=truncated_in_tool_layer/);
  });
});