import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  classifyNodeReadiness,
  edgeKey,
  findReadyAndSkippable,
  reopenTargetsAfterSettle,
  settleOutgoingEdges,
  type DagEdgeState,
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

/** Mirror runner post-complete: finish → settle → reopen fired targets. */
function completeNode(
  nodeId: string,
  def: WorkflowDefinition,
  edgeState: Map<string, DagEdgeState>,
  nodeVisits: Map<string, number>,
  finished: Set<string>,
  ctx: WorkflowContext,
  patch: { output?: string; verdict?: string; slot?: string },
): void {
  nodeVisits.set(nodeId, (nodeVisits.get(nodeId) ?? 0) + 1);
  const node = def.nodes![nodeId]!;
  const slot = patch.slot ?? node.as?.trim() ?? nodeId;
  ctx.roles[slot] = {
    output: patch.output ?? `${nodeId}#${nodeVisits.get(nodeId)}`,
    verdict: patch.verdict,
  };
  if (slot !== nodeId) {
    ctx.roles[nodeId] = ctx.roles[slot]!;
  }
  finished.add(nodeId);
  settleOutgoingEdges(nodeId, def.edges ?? [], edgeState, ctx);
  reopenTargetsAfterSettle(
    nodeId,
    def.edges ?? [],
    edgeState,
    nodeVisits,
    finished,
    def.nodes ?? {},
  );
}

function schedulePath(
  def: WorkflowDefinition,
  onComplete: (
    nodeId: string,
    priorVisits: number,
    ctx: WorkflowContext,
  ) => { output?: string; verdict?: string; slot?: string },
  maxRounds = 20,
): string[] {
  const edgeState = new Map<string, DagEdgeState>();
  const nodeVisits = new Map<string, number>();
  const finished = new Set<string>();
  const skipped = new Set<string>();
  const running = new Set<string>();
  const ctx: WorkflowContext = { user_task: 't', roles: {} };
  const path: string[] = [];

  for (let i = 0; i < maxRounds; i++) {
    const { ready, toSkip } = findReadyAndSkippable(
      def,
      edgeState,
      nodeVisits,
      finished,
      skipped,
      running,
    );
    for (const id of toSkip) skipped.add(id);
    if (ready.length === 0) break;
    for (const id of ready) {
      path.push(id);
      const prior = nodeVisits.get(id) ?? 0;
      completeNode(
        id,
        def,
        edgeState,
        nodeVisits,
        finished,
        ctx,
        onComplete(id, prior, ctx),
      );
    }
  }
  return path;
}

describe('workflow DAG readiness', () => {
  it('entry is ready first; successor after settle', () => {
    const def = linearDag();
    const edgeState = new Map<string, DagEdgeState>();
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

  it('conditional edge does not block required join; reopens impl only on needs_revision', () => {
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

    const edgeState = new Map<string, DagEdgeState>();
    const visits = new Map<string, number>();
    const finished = new Set<string>();
    const skipped = new Set<string>();
    const running = new Set<string>();
    const ctx: WorkflowContext = { user_task: 't', roles: {} };

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

    // After impl done (stays finished), review ready — impl must NOT be ready again
    completeNode('impl', def, edgeState, visits, finished, ctx, {
      output: 'work',
      slot: 'impl',
    });
    assert.ok(finished.has('impl'));
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
      'blocked',
    );
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

    // After review needs_revision, reopenTargets re-opens impl
    completeNode('review', def, edgeState, visits, finished, ctx, {
      output: 'fix',
      verdict: 'needs_revision',
      slot: 'review',
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
    // review stays finished until impl re-fires the required edge
    assert.ok(finished.has('review'));
  });

  it('dag-review happy path is plan → impl → review (not impl×3 first)', () => {
    const def = loadWorkflowDefinition('workflows/dag-review.json', process.cwd());
    const path = schedulePath(def, (id) => {
      if (id === 'review') {
        return { verdict: 'approved', output: 'lgtm', slot: 'reviewer' };
      }
      return { output: `${id}-ok` };
    });
    assert.deepEqual(path, ['plan', 'impl', 'review']);
  });

  it('dag-review revision loop is impl ⇄ review, not pre-burn max_visits', () => {
    const def = loadWorkflowDefinition('workflows/dag-review.json', process.cwd());
    let reviewCount = 0;
    const path = schedulePath(def, (id) => {
      if (id === 'review') {
        reviewCount += 1;
        // first two reviews request revision; third approves
        return {
          verdict: reviewCount < 3 ? 'needs_revision' : 'approved',
          output: `rev-${reviewCount}`,
          slot: 'reviewer',
        };
      }
      return { output: `${id}-ok` };
    });
    assert.deepEqual(path, [
      'plan',
      'impl',
      'review',
      'impl',
      'review',
      'impl',
      'review',
    ]);
  });

  it('approved review does not re-run review to burn max_visits', () => {
    const def = loadWorkflowDefinition('workflows/dag-review.json', process.cwd());
    const path = schedulePath(def, (id) => {
      if (id === 'review') {
        return { verdict: 'approved', output: 'ok', slot: 'reviewer' };
      }
      return { output: 'ok' };
    });
    assert.equal(path.filter((n) => n === 'review').length, 1);
    assert.equal(path.filter((n) => n === 'impl').length, 1);
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
