/**
 * DAG helpers for workflows with nodes + edges + entry (SPEC_WORKFLOW W3).
 *
 * Join semantics:
 * - Edges **without** `when` are required: source must have completed and edge fired.
 * - Edges **with** `when` are optional loop/branch: when source completes they fire or waive;
 *   they do not block first activation if required edges are satisfied.
 * - Pure conditional predecessors: ready when ≥1 optional edge has fired.
 */

import type {
  WorkflowContext,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowWhen,
} from './types.js';
import { evaluateWorkflowWhen } from './template.js';

export interface DagEdgeState {
  settled: boolean;
  fired: boolean;
  visits: number;
}

export function edgeKey(e: WorkflowEdge, index: number): string {
  return `${e.from}->${e.to}#${index}`;
}

export function settleOutgoingEdges(
  from: string,
  edges: WorkflowEdge[],
  edgeState: Map<string, DagEdgeState>,
  ctx: WorkflowContext,
): void {
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (e.from !== from) continue;
    const key = edgeKey(e, i);
    const prev = edgeState.get(key) ?? { settled: false, fired: false, visits: 0 };

    if (e.max_visits !== undefined && prev.visits >= e.max_visits) {
      edgeState.set(key, { settled: true, fired: false, visits: prev.visits });
      continue;
    }

    const ok =
      e.when === undefined || evaluateWorkflowWhen(e.when as WorkflowWhen, ctx);
    edgeState.set(key, {
      settled: true,
      fired: ok,
      visits: ok ? prev.visits + 1 : prev.visits,
    });
  }
}

export function waiveOutgoingFromSkipped(
  nodeId: string,
  edges: WorkflowEdge[],
  edgeState: Map<string, DagEdgeState>,
): void {
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (e.from !== nodeId) continue;
    edgeState.set(edgeKey(e, i), { settled: true, fired: false, visits: 0 });
  }
}

function sourceDone(
  from: string,
  finished: Set<string>,
  skipped: Set<string>,
): boolean {
  return finished.has(from) || skipped.has(from);
}

/**
 * @returns ready | blocked | skip (all optional waived / impossible)
 */
export function classifyNodeReadiness(
  nodeId: string,
  def: WorkflowDefinition,
  edgeState: Map<string, DagEdgeState>,
  nodeVisits: Map<string, number>,
  finished: Set<string>,
  skipped: Set<string>,
  running: Set<string>,
): 'ready' | 'blocked' | 'skip' {
  if (finished.has(nodeId) || skipped.has(nodeId) || running.has(nodeId)) {
    return 'blocked';
  }

  const node = def.nodes![nodeId]!;
  const maxV = node.max_visits ?? 1;
  if ((nodeVisits.get(nodeId) ?? 0) >= maxV) return 'blocked';

  const edges = def.edges ?? [];
  const incoming = edges
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.to === nodeId);

  if (incoming.length === 0) {
    // Entry (or orphan): start only once
    if (nodeId === def.entry && (nodeVisits.get(nodeId) ?? 0) === 0) {
      return 'ready';
    }
    return 'blocked';
  }

  const required = incoming.filter(({ e }) => e.when === undefined);
  const optional = incoming.filter(({ e }) => e.when !== undefined);

  // Entry may have only loop-back (conditional) edges — still start once.
  if (
    nodeId === def.entry &&
    (nodeVisits.get(nodeId) ?? 0) === 0 &&
    required.length === 0
  ) {
    return 'ready';
  }

  if (required.length > 0) {
    for (const { e, i } of required) {
      if (!sourceDone(e.from, finished, skipped)) return 'blocked';
      const st = edgeState.get(edgeKey(e, i));
      if (!st?.settled || !st.fired) return 'blocked';
    }
    return 'ready';
  }

  // Only conditional incoming (loop-back)
  let anySettled = false;
  let anyFired = false;
  let allWaived = true;
  for (const { e, i } of optional) {
    if (!sourceDone(e.from, finished, skipped)) {
      continue;
    }
    const st = edgeState.get(edgeKey(e, i));
    if (!st?.settled) return 'blocked';
    anySettled = true;
    if (st.fired) {
      anyFired = true;
      allWaived = false;
    }
  }
  if (anyFired) return 'ready';
  if (anySettled && allWaived) return 'skip';
  return 'blocked';
}

export function findReadyAndSkippable(
  def: WorkflowDefinition,
  edgeState: Map<string, DagEdgeState>,
  nodeVisits: Map<string, number>,
  finished: Set<string>,
  skipped: Set<string>,
  running: Set<string>,
): { ready: string[]; toSkip: string[] } {
  const ready: string[] = [];
  const toSkip: string[] = [];
  for (const id of Object.keys(def.nodes ?? {})) {
    const c = classifyNodeReadiness(
      id,
      def,
      edgeState,
      nodeVisits,
      finished,
      skipped,
      running,
    );
    if (c === 'ready') ready.push(id);
    else if (c === 'skip') toSkip.push(id);
  }
  return { ready, toSkip };
}

/** Validate DAG shape (cycles with max_visits are allowed). */
export function assertValidDag(def: WorkflowDefinition): void {
  if (!def.nodes || !def.entry || !def.edges) {
    throw new Error('DAG workflow requires nodes, edges, and entry');
  }
  if (!def.nodes[def.entry]) {
    throw new Error(`DAG entry "${def.entry}" missing from nodes`);
  }
}
