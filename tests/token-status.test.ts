import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatCompactTokens,
  readUsageTokens,
  TokenStatusTracker,
} from '../src/tui/pi/token-status.js';

describe('formatCompactTokens', () => {
  it('formats small and large counts', () => {
    assert.equal(formatCompactTokens(0), '0');
    assert.equal(formatCompactTokens(999), '999');
    assert.equal(formatCompactTokens(1_000), '1k');
    assert.equal(formatCompactTokens(1_500), '1.5k');
    assert.equal(formatCompactTokens(12_345), '12.3k');
    assert.equal(formatCompactTokens(17_300), '17.3k');
    assert.equal(formatCompactTokens(1_200_000), '1.2M');
    assert.equal(formatCompactTokens(12_000_000), '12M');
  });
});

describe('readUsageTokens', () => {
  it('reads total_tokens when present', () => {
    assert.deepEqual(
      readUsageTokens({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
      { prompt: 100, completion: 20, billed: 120 },
    );
  });

  it('sums prompt+completion when total missing', () => {
    assert.deepEqual(readUsageTokens({ prompt_tokens: 100, completion_tokens: 20 }), {
      prompt: 100,
      completion: 20,
      billed: 120,
    });
  });

  it('returns empty for bad input', () => {
    assert.deepEqual(readUsageTokens(undefined), {});
    assert.deepEqual(readUsageTokens(null), {});
    assert.deepEqual(readUsageTokens('x'), {});
  });
});

describe('TokenStatusTracker', () => {
  it('accumulates main billed and tracks main-agent context', () => {
    const t = new TokenStatusTracker();
    t.bindSession('s1');
    t.onLlmDone({ prompt_tokens: 8_000, completion_tokens: 200, total_tokens: 8_200 });
    t.onLlmDone({ prompt_tokens: 9_000, completion_tokens: 100, total_tokens: 9_100 });
    assert.equal(t.mainBilled, 17_300);
    assert.equal(t.spawnBilled, 0);
    assert.equal(t.totalBilled, 17_300);
    assert.equal(t.lastContext, 9_000);
    assert.equal(t.formatStatus(1_000_000), 'Σm:17.3k · ctx:9k/1M');
  });

  it('splits spawn billed from main and keeps ctx on main', () => {
    const t = new TokenStatusTracker();
    t.bindSession('s1');
    t.onLlmDone({ prompt_tokens: 5_000, completion_tokens: 50, total_tokens: 5_050 });
    t.onSpawnStart();
    t.onLlmDone({ prompt_tokens: 1_000, completion_tokens: 20, total_tokens: 1_020 });
    t.onLlmDone({ prompt_tokens: 2_000, completion_tokens: 10, total_tokens: 2_010 });
    t.onSpawnEnd();
    t.onLlmDone({ prompt_tokens: 6_000, completion_tokens: 0, total_tokens: 6_000 });
    assert.equal(t.mainBilled, 11_050);
    assert.equal(t.spawnBilled, 3_030);
    assert.equal(t.totalBilled, 14_080);
    assert.equal(t.lastContext, 6_000);
    assert.equal(t.formatStatus(500_000), 'Σm:11.1k · Σs:3k · ctx:6k/500k');
  });

  it('resets when session key changes', () => {
    const t = new TokenStatusTracker();
    t.bindSession('a');
    t.onLlmDone({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
    t.onSpawnStart();
    t.onLlmDone({ prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 });
    t.bindSession('b');
    assert.equal(t.mainBilled, 0);
    assert.equal(t.spawnBilled, 0);
    assert.equal(t.totalBilled, 0);
    assert.equal(t.lastContext, undefined);
    assert.equal(t.formatStatus(), '');
  });
});
