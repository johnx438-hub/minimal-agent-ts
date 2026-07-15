import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  classifyNodeReadiness,
  edgeKey,
  findReadyAndSkippable,
  settleOutgoingEdges,
} from '../src/workflow/dag.js';
import { loadWorkflowDefinition, resolveWorkflowRef } from '../src/workflow/load-workflow.js';
import type { WorkflowContext, WorkflowDefinition } from '../src/workflow/types.js';

function linearDag(): WorkflowDefinition {
  return {
    name: 'linear',
    roles: {
      a: { prompt: 'A', tools: ['read_file'] },
      b: { prompt: 'B', tools: ['read_file'] },
    },
    entry: 'n1',
    nodes: {
      n1: { role: 'a', input: '{{user_task}}' },
      n2: { role: 'b', input: '{{n1.output}}' },
    },
    edges: [{ from: 'n1', to: 'n2' }],
  };
}

describe('workflow DAG readiness', () => {
  it('entry is ready first; successor after settle', () => {
    const def = linearDag();
    const edgeState = new Map();
    const visits = new Map<string, number>();
    const finished = new Set<string>();
    const skipped = new Set<string>();
    const running = new Set<string>();

    let { ready } = findReadyAndSkippable(
      def,
      edgeState,
      visits,
      finished,
      skipped,
      running,
    );
    assert.deepEqual(ready, ['n1']);

    // simulate n1 complete
    visits.set('n1', 1);
    finished.add('n1');
    const ctx: WorkflowContext = {
      user_task: 't',
      roles: { n1: { output: 'plan' } },
    };
    settleOutgoingEdges('n1', def.edges!, edgeState, ctx);

    ({ ready } = findReadyAndSkippable(
      def,
      edgeState,
      visits,
      finished,
      skipped,
      running,
    ));
    assert.deepEqual(ready, ['n2']);
  });

  it('conditional edge does not block required join', () => {
    const def: WorkflowDefinition = {
      name: 'loopish',
      roles: { w: { prompt: 'w', tools: [] }, r: { prompt: 'r', tools: [] } },
      entry: 'impl',
      nodes: {
        impl: { role: 'w', input: 'go', max_visits: 3 },
        review: { role: 'r', input: 'check', max_visits: 3 },
      },
      edges: [
        { from: 'impl', to: 'review' },
        {
          from: 'review',
          to: 'impl',
          when: { path: 'review.verdict', eq: 'needs_revision' },
          max_visits: 2,
        },
      ],
    };

    // First: only entry impl (no required in-edges)
    const edgeState = new Map();
    const visits = new Map<string, number>();
    const finished = new Set<string>();
    const skipped = new Set<string>();
    const running = new Set<string>();

    assert.equal(
      classifyNodeReadiness(
        'impl',
        def,
        edgeState,
        visits,
        finished,
        skipped,
        running,
      ),
      'ready',
    );

    // After impl done, review ready
    visits.set('impl', 1);
    finished.add('impl');
    settleOutgoingEdges('impl', def.edges!, edgeState, {
      user_task: 't',
      roles: { impl: { output: 'work' } },
    });
    assert.equal(
      classifyNodeReadiness(
        'review',
        def,
        edgeState,
        visits,
        finished,
        skipped,
        running,
      ),
      'ready',
    );

    // After review needs_revision, impl ready again
    finished.delete('impl'); // allow re-visit under max_visits
    visits.set('review', 1);
    finished.add('review');
    settleOutgoingEdges('review', def.edges!, edgeState, {
      user_task: 't',
      roles: {
        impl: { output: 'work' },
        review: { output: 'fix', verdict: 'needs_revision' },
      },
    });
    assert.equal(
      classifyNodeReadiness(
        'impl',
        def,
        edgeState,
        visits,
        finished,
        skipped,
        running,
      ),
      'ready',
    );
  });

  it('edgeKey is stable', () => {
    const e = { from: 'a', to: 'b' };
    assert.equal(edgeKey(e, 0), 'a->b#0');
  });
});

describe('workflow load + resolve ref', () => {
  it('loads DAG definition without flow', () => {
    const cwd = process.cwd();
    const def = loadWorkflowDefinition('workflows/dag-review.json', cwd);
    assert.equal(def.name, 'dag-review');
    assert.ok(def.nodes?.plan);
    assert.equal(def.entry, 'plan');
    assert.ok(def.edges && def.edges.length >= 2);
  });

  it('resolveWorkflowRef finds by name and registry', () => {
    const cwd = process.cwd();
    const byName = resolveWorkflowRef('dag-review', cwd);
    assert.ok(byName?.endsWith('dag-review.json'));

    const byReg = resolveWorkflowRef('review', cwd, {
      workflows: { review: 'workflows/review-loop.json' },
    });
    assert.ok(byReg?.endsWith('review-loop.json'));

    const miss = resolveWorkflowRef('no-such-workflow-xyz', cwd);
    assert.equal(miss, null);
  });

  it('rejects flow+dag together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-bad-'));
    const path = join(dir, 'bad.json');
    writeFileSync(
      path,
      JSON.stringify({
        name: 'bad',
        roles: { a: { prompt: 'x', tools: [] } },
        flow: [{ role: 'a', input: 't' }],
        entry: 'n1',
        nodes: { n1: { role: 'a', input: 't' } },
        edges: [],
      }),
      'utf8',
    );
    assert.throws(() => loadWorkflowDefinition(path, dir), /either flow/);
  });
});
