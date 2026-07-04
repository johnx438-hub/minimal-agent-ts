import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EMPTY_CONTINUE_NUDGE,
  FORCED_SUMMARY_MESSAGE,
  FORCED_SUMMARY_RETRY_NUDGE,
  isLoopGuardInjection,
  isRegressionTaskPrompt,
  LoopGuard,
  SOFT_NUDGE_MESSAGE,
  stripLoopGuardInjections,
  toolFingerprint,
  type ToolTurnRecord,
} from '../src/loop-guard.js';
import type { ChatMessage } from '../src/types.js';

function record(name: string, args: Record<string, unknown>, output: string): ToolTurnRecord {
  return { name, argsJson: JSON.stringify(args), output };
}

describe('loop guard regression exemptions', () => {
  it('detects regression task prefixes', () => {
    assert.equal(isRegressionTaskPrompt('[regression] rerun code_review HEAD~2'), true);
    assert.equal(isRegressionTaskPrompt('regression: verify p0 telemetry'), true);
    assert.equal(isRegressionTaskPrompt('normal task'), false);
  });

  it('does not count repeated code_review turns toward forced summary', () => {
    const guard = new LoopGuard({ enabled: true, mode: 'inject', hardCeiling: 200 });
    const row = record('code_review', { scope: 'HEAD~2' }, 'report v1');

    for (let i = 0; i < 5; i++) {
      const decision = guard.afterToolTurn(i + 1, [row]);
      assert.equal(decision.action, 'continue');
    }
  });

  it('allows repeated telemetry reads during regression mode', () => {
    const guard = new LoopGuard({
      enabled: true,
      mode: 'inject',
      hardCeiling: 200,
      regressionMode: true,
    });
    const row = record(
      'read_file',
      { path: 'workspace/p0-telemetry/latest.json' },
      'same body',
    );

    for (let i = 0; i < 5; i++) {
      const decision = guard.afterToolTurn(i + 1, [row]);
      assert.equal(decision.action, 'continue');
    }
  });

  it('nudges on repeated unrelated reads in normal mode', () => {
    const guard = new LoopGuard({ enabled: true, mode: 'inject', hardCeiling: 200 });
    const row = record('read_file', { path: 'src/agent.ts' }, 'same body');

    assert.equal(guard.afterToolTurn(1, [row]).action, 'continue');
    assert.equal(guard.afterToolTurn(2, [row]).action, 'continue');
    assert.equal(guard.afterToolTurn(3, [row]).action, 'soft_nudge');
    assert.equal(guard.afterToolTurn(4, [row]).action, 'forced_summary');
  });

  it('raises repeat thresholds for unrelated reads in regression mode', () => {
    const guard = new LoopGuard({
      enabled: true,
      mode: 'inject',
      hardCeiling: 200,
      regressionMode: true,
    });
    const row = record('read_file', { path: 'src/agent.ts' }, 'same body');

    assert.equal(guard.afterToolTurn(1, [row]).action, 'continue');
    assert.equal(guard.afterToolTurn(2, [row]).action, 'continue');
    assert.equal(guard.afterToolTurn(3, [row]).action, 'continue');
    assert.equal(guard.afterToolTurn(4, [row]).action, 'continue');
    assert.equal(guard.afterToolTurn(5, [row]).action, 'soft_nudge');
    assert.equal(guard.afterToolTurn(6, [row]).action, 'forced_summary');
  });

  it('does not accumulate state when loop guard is disabled', () => {
    const guard = new LoopGuard({ enabled: false, mode: 'off', hardCeiling: 200 });
    const row = record('read_file', { path: 'src/agent.ts' }, 'same body');
    const internal = guard as unknown as {
      seenFingerprints: Set<string>;
      seenResults: Map<string, string>;
      emptyStreak: number;
      lastTurnEntries: Map<string, string> | null;
    };

    for (let i = 0; i < 50; i++) {
      assert.equal(guard.afterToolTurn(i + 1, [row]).action, 'continue');
      assert.equal(guard.afterEmptyResponse().action, 'continue');
    }

    assert.equal(internal.seenFingerprints.size, 0);
    assert.equal(internal.seenResults.size, 0);
    assert.equal(internal.emptyStreak, 0);
    assert.equal(internal.lastTurnEntries, null);
  });

  it('terminates after repeated empty responses without forced summary', () => {
    const guard = new LoopGuard({ enabled: true, mode: 'inject', hardCeiling: 200 });

    assert.equal(guard.afterEmptyResponse().action, 'continue');
    assert.equal(guard.afterEmptyResponse().action, 'continue');
    const decision = guard.afterEmptyResponse();
    assert.equal(decision.action, 'terminate');
    assert.match(decision.reason ?? '', /empty responses/);
    assert.equal(guard.forcedSummaryPending, false);
  });

  it('keeps forced summary active until text response', () => {
    const guard = new LoopGuard({ enabled: true, mode: 'inject', hardCeiling: 200 });
    guard.forcedSummaryPending = true;

    assert.equal(guard.shouldForceSummaryTurn(), true);
    guard.activateForcedSummary();
    assert.equal(guard.shouldForceSummaryTurn(), true);

    guard.afterTextResponse();
    assert.equal(guard.shouldForceSummaryTurn(), false);
  });

  it('strips loop guard injection messages from history', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Working directory: /tmp\n\nTask:\nhello' },
      { role: 'assistant', content: 'ok', turn: 1 },
      { role: 'user', content: SOFT_NUDGE_MESSAGE },
      { role: 'user', content: FORCED_SUMMARY_MESSAGE },
      { role: 'user', content: EMPTY_CONTINUE_NUDGE },
      { role: 'user', content: FORCED_SUMMARY_RETRY_NUDGE },
    ];

    assert.equal(isLoopGuardInjection(messages[2]!), true);
    assert.equal(stripLoopGuardInjections(messages).length, 2);
  });

  it('fingerprints code_review by scope and focus', () => {
    const a = toolFingerprint('code_review', JSON.stringify({ scope: 'HEAD~2' }));
    const b = toolFingerprint('code_review', JSON.stringify({ scope: 'HEAD~3' }));
    const c = toolFingerprint(
      'code_review',
      JSON.stringify({ scope: 'HEAD~2', focus: 'bug' }),
    );
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });
});