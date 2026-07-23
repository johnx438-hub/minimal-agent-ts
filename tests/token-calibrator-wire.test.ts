import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHARS_PER_TOKEN,
  createBudgetConfig,
  estimateToolDefsTokens,
  estimatePromptTokens,
  estimateTokens,
  heavyCompressionThreshold,
  shouldRunHeavyCompression,
} from '../src/context/budget.js';
import { runCompressionEvent } from '../src/context/heavy-compression.js';
import { TokenCalibrator } from '../src/context/token-calibrator.js';
import { shouldForcePointerize } from '../src/pointerize.js';
import type { ChatMessage, ToolDefinition } from '../src/types.js';

function fillerTokens(targetTokens: number): string {
  return 'x'.repeat(Math.ceil(targetTokens * CHARS_PER_TOKEN) + 50);
}

describe('estimateToolDefsTokens', () => {
  it('returns 0 for empty tools', () => {
    assert.equal(estimateToolDefsTokens(undefined), 0);
    assert.equal(estimateToolDefsTokens([]), 0);
  });

  it('counts JSON size of tool schemas', () => {
    const tools: ToolDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'run_shell',
          description: 'Run a shell command',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
          },
        },
      },
    ];
    assert.ok(estimateToolDefsTokens(tools) > 10);
  });
});

describe('estimatePromptTokens with calibrator', () => {
  it('is identity without calibrator', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: fillerTokens(500) }];
    assert.equal(estimatePromptTokens(msgs), estimateTokens(msgs));
  });

  it('applies scale when calibrator is set', () => {
    const cal = new TokenCalibrator({ alpha: 1, minRaw: 1 });
    cal.observe(1000, 2000); // scale → 2
    const msgs: ChatMessage[] = [{ role: 'user', content: fillerTokens(500) }];
    const raw = estimateTokens(msgs);
    assert.equal(estimatePromptTokens(msgs, undefined, cal), cal.apply(raw));
    assert.ok(estimatePromptTokens(msgs, undefined, cal) >= raw * 2 - 1);
  });
});

describe('calibrated budget thresholds', () => {
  it('shouldForcePointerize triggers earlier when scale > 1', () => {
    const budget = createBudgetConfig('unknown'); // 200k total
    // usable ≈ 190k; soft force at 0.75 → ~142.5k
    // raw ~80k under threshold; *2 over
    const msgs: ChatMessage[] = [
      { role: 'user', content: fillerTokens(80_000) },
    ];
    assert.equal(shouldForcePointerize(msgs, budget, { soft_force_ratio: 0.75 }), false);

    const cal = new TokenCalibrator({ alpha: 1, minRaw: 1 });
    cal.observe(1000, 2000); // scale 2
    assert.equal(
      shouldForcePointerize(msgs, budget, { soft_force_ratio: 0.75 }, cal),
      true,
    );
  });

  it('runCompressionEvent fires with high scale when raw is under threshold', () => {
    const budget = createBudgetConfig('unknown');
    const firstThreshold = heavyCompressionThreshold(budget, false);
    // Place raw just under first heavy threshold; scale=2 pushes over.
    const target = Math.floor(firstThreshold * 0.6);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: fillerTokens(target) },
    ];
    const userTask: ChatMessage = { role: 'user', content: 'task' };

    assert.equal(
      shouldRunHeavyCompression(estimateTokens(messages), budget, false),
      false,
    );

    const cal = new TokenCalibrator({ alpha: 1, minRaw: 1 });
    cal.observe(1000, 2000);

    const applied = runCompressionEvent({
      messages,
      currentTurn: 2,
      budget,
      userTask,
      calibrator: cal,
    });
    assert.equal(applied, true);
  });
});
