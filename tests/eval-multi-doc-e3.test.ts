import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { listTaskIds } from '../src/eval/load.js';
import { defaultProjectRoot, estimateCostUsd, runEval } from '../src/eval/run.js';
import { resolveEvalRoot } from '../src/eval/load.js';

const ROOT = defaultProjectRoot();

describe('eval E3 multi_doc_01', () => {
  it('lists multi_doc_01 among tasks', () => {
    const ids = listTaskIds(resolveEvalRoot(ROOT));
    assert.ok(ids.includes('state_chain_01'));
    assert.ok(ids.includes('multi_doc_01'));
  });

  it('setup + planted answer scores pass', async () => {
    const result = await runEval({
      projectRoot: ROOT,
      taskId: 'multi_doc_01',
      strategyId: 'minimal_full',
      dryRun: true,
      plantCorrectAnswer: true,
      runId: `e3_multi_${Date.now()}`,
    });
    assert.equal(result.summary.task_success, true);
    assert.ok(existsSync(join(result.runDir, 'workspace', 'docs', '02_operations.md')));
    const ops = readFileSync(
      join(result.runDir, 'workspace', 'docs', '02_operations.md'),
      'utf8',
    );
    assert.match(ops, /Project Codename: ORBIT-7/);
    assert.match(ops, /Budget Cap USD: 42000/);
  });

  it('wrong answer fails score', async () => {
    const result = await runEval({
      projectRoot: ROOT,
      taskId: 'multi_doc_01',
      strategyId: 'minimal_full',
      dryRun: true,
      plantCorrectAnswer: false,
      runId: `e3_multi_fail_${Date.now()}`,
    });
    assert.equal(result.summary.task_success, false);
  });

  it('estimateCostUsd uses env prices when set', () => {
    const prevP = process.env.EVAL_PRICE_PROMPT_PER_1M;
    const prevC = process.env.EVAL_PRICE_COMPLETION_PER_1M;
    try {
      process.env.EVAL_PRICE_PROMPT_PER_1M = '1'; // $1 / 1M
      process.env.EVAL_PRICE_COMPLETION_PER_1M = '2';
      const c = estimateCostUsd(1_000_000, 500_000);
      assert.equal(c, 2); // 1 + 1
    } finally {
      if (prevP === undefined) delete process.env.EVAL_PRICE_PROMPT_PER_1M;
      else process.env.EVAL_PRICE_PROMPT_PER_1M = prevP;
      if (prevC === undefined) delete process.env.EVAL_PRICE_COMPLETION_PER_1M;
      else process.env.EVAL_PRICE_COMPLETION_PER_1M = prevC;
    }
  });
});
