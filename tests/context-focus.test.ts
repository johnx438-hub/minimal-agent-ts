import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONTEXT_FOCUS_KEEP_MAX,
  runContextFocusTool,
} from '../src/tools/context-focus.js';
import type { AgentConfig } from '../src/types.js';
import {
  materializePriorTurnTools,
  shouldForcePointerize,
  tickPointerizeFocus,
} from '../src/pointerize.js';
import { createBudgetConfig } from '../src/context/budget.js';

function baseConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiKey: 'k',
    baseUrl: 'https://x',
    model: 'm',
    maxTurns: 0,
    cwd: '/tmp',
    allowShell: false,
    allowWeb: false,
    spawnDepth: 0,
    ...over,
  };
}

describe('context_focus tool', () => {
  it('sets focus on main agent and clears', () => {
    const config = baseConfig();
    const out = runContextFocusTool(
      'context_focus',
      { keep_inline_turns: 14, ttl_turns: 5, reason: 'review' },
      config,
    );
    assert.match(out ?? '', /ok: context_focus active/);
    assert.equal(config.pointerizeFocus?.keepInlineTurns, 14);
    assert.equal(config.pointerizeFocus?.remainingTurns, 5);

    const cleared = runContextFocusTool('context_focus', { clear: true }, config);
    assert.match(cleared ?? '', /cleared/);
    assert.equal(config.pointerizeFocus, undefined);
  });

  it('rejects child spawnDepth', () => {
    const config = baseConfig({ spawnDepth: 1 });
    const out = runContextFocusTool('context_focus', {}, config);
    assert.match(out ?? '', /only available on the main agent/);
  });

  it('caps keep_inline_turns', () => {
    const config = baseConfig();
    runContextFocusTool(
      'context_focus',
      { keep_inline_turns: 99, ttl_turns: 100 },
      config,
    );
    assert.equal(config.pointerizeFocus?.keepInlineTurns, CONTEXT_FOCUS_KEEP_MAX);
    assert.equal(config.pointerizeFocus?.remainingTurns, 30);
  });
});

describe('pointerize hold + focus', () => {
  it('hold mode skips pointerize unless force', () => {
    const n = materializePriorTurnTools([], 10, {
      keepInlineTurns: 2,
      pointerizeMode: 'hold',
      force: false,
    });
    assert.equal(n, 0);
  });

  it('tickPointerizeFocus expires', () => {
    const f = { remainingTurns: 1 };
    assert.equal(tickPointerizeFocus(f), true);
    assert.equal(f.remainingTurns, 0);
  });

  it('shouldForcePointerize respects soft ratio', () => {
    const budget = createBudgetConfig('unknown'); // 200k
    const tiny = [{ role: 'user' as const, content: 'hi' }];
    assert.equal(shouldForcePointerize(tiny, budget, { soft_force_ratio: 0.75 }), false);
  });
});
