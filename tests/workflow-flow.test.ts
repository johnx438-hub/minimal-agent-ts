import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateWorkflowWhen,
  lookupWorkflowPath,
  renderWorkflowTemplate,
  resolveSwitchOn,
} from '../src/workflow/template.js';
import {
  isLoopItem,
  isParallelItem,
  isSwitchItem,
  isWorkflowStep,
} from '../src/workflow/runner.js';
import type { WorkflowContext, WorkflowFlowItem } from '../src/workflow/types.js';

function ctx(partial: Partial<WorkflowContext> & { user_task?: string }): WorkflowContext {
  return {
    user_task: partial.user_task ?? 'task',
    roles: partial.roles ?? {},
  };
}

describe('workflow W2 when / template', () => {
  it('evaluateWorkflowWhen supports string and object forms', () => {
    const c = ctx({
      roles: {
        reviewer: { output: 'notes', verdict: 'needs_revision' },
      },
    });
    assert.equal(
      evaluateWorkflowWhen("{{reviewer.verdict}} == 'needs_revision'", c),
      true,
    );
    assert.equal(
      evaluateWorkflowWhen({ path: 'reviewer.verdict', eq: 'needs_revision' }, c),
      true,
    );
    assert.equal(
      evaluateWorkflowWhen({ path: 'reviewer.verdict', eq: 'approved' }, c),
      false,
    );
    assert.equal(evaluateWorkflowWhen({ path: 'missing.verdict', eq: 'x' }, c), false);
  });

  it('lookup supports as-slot names', () => {
    const c = ctx({
      roles: {
        worker_api: { output: 'API done', verdict: undefined },
        worker_ui: { output: 'UI done' },
      },
    });
    assert.equal(lookupWorkflowPath(c, 'worker_api.output'), 'API done');
    assert.equal(
      renderWorkflowTemplate('A={{worker_api.output}} B={{worker_ui.output}}', c),
      'A=API done B=UI done',
    );
  });

  it('resolveSwitchOn reads path or template', () => {
    const c = ctx({
      roles: { reviewer: { output: 'x', verdict: 'approved' } },
    });
    assert.equal(resolveSwitchOn('reviewer.verdict', c), 'approved');
    assert.equal(resolveSwitchOn('{{reviewer.verdict}}', c), 'approved');
  });
});

describe('workflow parallel slot uniqueness', () => {
  it('documents auto as = role#index when as omitted', () => {
    // Mirrors runner parallel branch: as: step.as?.trim() || `${step.role}#${index}`
    const steps = [
      { role: 'worker', input: 'a' },
      { role: 'worker', input: 'b' },
    ];
    const slots = steps.map(
      (s, i) => (s as { as?: string }).as?.trim() || `${s.role}#${i}`,
    );
    assert.deepEqual(slots, ['worker#0', 'worker#1']);
    assert.notEqual(slots[0], slots[1]);
  });
});

describe('workflow flow item guards', () => {
  it('classifies step / loop / parallel / switch', () => {
    const step: WorkflowFlowItem = { role: 'worker', input: 'go', as: 'worker_a' };
    const loop: WorkflowFlowItem = {
      loop: { when: { path: 'r.verdict', eq: 'x' }, max_rounds: 1, steps: [step] },
    };
    const par: WorkflowFlowItem = {
      parallel: { steps: [step, { role: 'worker', input: 'b', as: 'worker_b' }] },
    };
    const sw: WorkflowFlowItem = {
      switch: {
        on: 'reviewer.verdict',
        cases: { approved: [step] },
        default: [],
      },
    };
    assert.equal(isWorkflowStep(step), true);
    assert.equal(isLoopItem(loop), true);
    assert.equal(isParallelItem(par), true);
    assert.equal(isSwitchItem(sw), true);
    assert.equal(isWorkflowStep(loop), false);
    assert.equal(isParallelItem(step), false);
  });
});
