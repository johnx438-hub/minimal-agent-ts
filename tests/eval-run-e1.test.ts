import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultProjectRoot, runEval } from '../src/eval/run.js';
import {
  computeHotTokenStats,
  computeRepeatToolRate,
  EvalTelemetryCollector,
  toolArgsFingerprint,
} from '../src/eval/telemetry.js';

const ROOT = defaultProjectRoot();

describe('eval telemetry helpers', () => {
  it('fingerprints tool args by path/command keys', () => {
    assert.equal(
      toolArgsFingerprint('read_file', JSON.stringify({ path: 'a.txt', offset: 1 })),
      'read_file|path=a.txt',
    );
  });

  it('collapses absolute paths to trailing segments (no prefix collision)', () => {
    const abs1 =
      '/home/archer/zerostack-analysis/minimal-agent-ts/eval/runs/multi_doc_01__minimal_full__x/workspace/docs/03_distractor.md';
    const abs2 =
      '/home/archer/zerostack-analysis/minimal-agent-ts/eval/runs/multi_doc_01__minimal_full__x/workspace/docs/04_distractor.md';
    const rel1 = 'docs/03_distractor.md';
    const fp1 = toolArgsFingerprint('read_file', JSON.stringify({ path: abs1 }));
    const fp2 = toolArgsFingerprint('read_file', JSON.stringify({ path: abs2 }));
    const fpRel = toolArgsFingerprint('read_file', JSON.stringify({ path: rel1 }));
    assert.equal(fp1, 'read_file|path=docs/03_distractor.md');
    assert.equal(fpRel, 'read_file|path=docs/03_distractor.md');
    assert.notEqual(fp1, fp2);
    assert.equal(fp2, 'read_file|path=docs/04_distractor.md');
  });

  it('aggregates llm_done and tool_call into turns', () => {
    const c = new EvalTelemetryCollector();
    c.onEvent({ type: 'turn_start', turn: 1 }, 1000);
    c.onEvent(
      {
        type: 'llm_done',
        turn: 1,
        finishReason: 'stop',
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      },
      1500,
    );
    c.onEvent(
      {
        type: 'tool_call',
        turn: 1,
        call_id: 'c1',
        name: 'read_file',
        args: JSON.stringify({ path: 'x' }),
      },
      1600,
    );
    c.onEvent(
      {
        type: 'compression',
        turn: 2,
        pointerized: 1,
        pruned: 0,
        pointer_compacted: 0,
        heavy_compression: false,
      },
      2000,
    );
    const rows = c.toRecords();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].prompt_tokens, 100);
    assert.equal(rows[0].wall_ms, 500);
    assert.equal(rows[0].tool_calls.length, 1);
    assert.equal(rows[1].pointerized, 1);
  });

  it('computes repeat rate and hot token stats', () => {
    const records = [
      {
        turn: 1,
        prompt_tokens: 100,
        tool_calls: [
          { name: 'r', args_fp: 'a', call_id: '1' },
          { name: 'r', args_fp: 'a', call_id: '2' },
          { name: 'r', args_fp: 'b', call_id: '3' },
        ],
        loop_guard_actions: [] as string[],
      },
      {
        turn: 2,
        prompt_tokens: 200,
        tool_calls: [],
        loop_guard_actions: [],
      },
    ];
    const rep = computeRepeatToolRate(records);
    assert.equal(rep.total, 3);
    assert.equal(rep.unique, 2);
    assert.ok(Math.abs(rep.rate - 1 / 3) < 1e-9);
    const hot = computeHotTokenStats(records);
    assert.equal(hot.mean, 150);
    assert.equal(hot.sum, 300);
  });
});

describe('eval run E1 dry-run', () => {
  it('writes manifest/turns/summary and scores planted answer', async () => {
    const runId = `test_dry_${Date.now()}`;
    const result = await runEval({
      projectRoot: ROOT,
      taskId: 'state_chain_01',
      strategyId: 'minimal_full',
      dryRun: true,
      plantCorrectAnswer: true,
      runId,
      maxTurns: 5,
    });

    assert.equal(result.summary.task_success, true);
    assert.equal(result.manifest.dry_run, true);
    assert.equal(result.manifest.task_id, 'state_chain_01');
    assert.equal(result.manifest.strategy_id, 'minimal_full');
    assert.ok(result.manifest.git_sha === null || result.manifest.git_sha.length > 0);

    const dir = result.runDir;
    assert.ok(existsSync(join(dir, 'manifest.json')));
    assert.ok(existsSync(join(dir, 'summary.json')));
    assert.ok(existsSync(join(dir, 'turns.jsonl')));
    assert.ok(existsSync(join(dir, 'score.json')));
    assert.ok(existsSync(join(dir, 'final.txt')));

    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    assert.equal(summary.task_success, true);
    assert.equal(summary.turns_used, 0); // no LLM events in dry-run

    // dry-run fail path
    const failId = `test_dry_fail_${Date.now()}`;
    const fail = await runEval({
      projectRoot: ROOT,
      taskId: 'state_chain_01',
      strategyId: 'minimal_no_pointerize',
      dryRun: true,
      plantCorrectAnswer: false,
      runId: failId,
    });
    assert.equal(fail.summary.task_success, false);
  });

  it('loads all strategy files without throw', async () => {
    const strategies = readdirSync(join(ROOT, 'eval/strategies'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
    assert.ok(strategies.includes('minimal_full'));
    for (const id of strategies) {
      const r = await runEval({
        projectRoot: ROOT,
        taskId: 'state_chain_01',
        strategyId: id,
        dryRun: true,
        plantCorrectAnswer: true,
        runId: `strat_${id}_${Date.now()}`,
      });
      assert.equal(r.summary.task_success, true, id);
    }
  });
});
