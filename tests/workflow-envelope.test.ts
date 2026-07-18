import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSystemPrompt } from '../src/agent-prompt.js';
import type { AgentConfig } from '../src/types.js';
import {
  applyWorkflowEnvelope,
  buildWorkflowRoleEnvelope,
  inferDutyHint,
} from '../src/workflow/envelope.js';
import {
  WORKFLOW_HANDOFF_TOOL,
  formatHandoffPayloadAsOutput,
  resolveHandoffSlotOutput,
  runWorkflowHandoffTool,
  type WorkflowRoleRuntime,
} from '../src/workflow/handoff-tool.js';
import {
  extractWorkflowVerdict,
  normalizeWorkflowVerdict,
} from '../src/workflow/verdict.js';

describe('workflow envelope (W4 isolation)', () => {
  it('injects handoff duty with negative feedback, no self-contradiction', () => {
    const env = buildWorkflowRoleEnvelope({
      workflowName: 'dag-review',
      role: 'planner',
      slot: 'plan',
      phase: 'dag',
      nodeId: 'plan',
      canWrite: false,
      dutyHint: 'planner',
    });
    assert.match(env, /workflow_envelope/);
    assert.match(env, /What counts as success/);
    assert.match(env, /Negative feedback/);
    assert.match(env, /workflow_handoff/);
    assert.match(env, /full numbered plan/i);
    assert.match(env, /self-contained/i);
    assert.match(env, /stub summary|tiny handoff/i);
    assert.match(env, /Also valid/);
    assert.match(env, /parent session/i);
    assert.match(env, /burns max_turns|turn_ceiling|incomplete/i);
    // Do not paste third-party “stop calling all tools / start summarizing” compression copy.
    assert.doesNotMatch(env, /stop calling (all )?tools and (start )?summar/i);
    assert.doesNotMatch(env, /voided|作废|session will be deleted/i);
    // Avoid “stop tools” in the same breath as “use the handoff tool”.
    assert.doesNotMatch(
      env,
      /stop calling tools[^\n]*handoff text \(tool/i,
    );
  });

  it('applyWorkflowEnvelope appends to role system only', () => {
    const out = applyWorkflowEnvelope('You are planner.', {
      workflowName: 'x',
      role: 'planner',
      slot: 'plan',
      phase: 'role',
      canWrite: false,
    });
    assert.match(out, /^You are planner\./);
    assert.match(out, /\[workflow_envelope\]/);
  });

  it('main buildSystemPrompt does not contain workflow_envelope', () => {
    const config = {
      apiKey: 'x',
      baseUrl: 'http://localhost',
      model: 'test',
      maxTurns: 5,
      cwd: process.cwd(),
      allowShell: false,
      allowWeb: false,
    } as AgentConfig;
    const sys = buildSystemPrompt(config);
    assert.doesNotMatch(sys, /workflow_envelope/);
    assert.doesNotMatch(sys, /workflow_handoff/);
  });

  it('inferDutyHint maps common role names', () => {
    assert.equal(inferDutyHint('planner'), 'planner');
    assert.equal(inferDutyHint('reviewer'), 'reviewer');
    assert.equal(inferDutyHint('worker'), 'worker');
  });
});

describe('workflow_handoff tool', () => {
  it('records payload on workflowRole runtime', () => {
    const runtime: WorkflowRoleRuntime = { handoff: null };
    const msg = runWorkflowHandoffTool(
      {
        kind: 'plan',
        summary: '1. fix foo\n2. test',
        assumptions: 'single package',
      },
      runtime,
    );
    assert.match(msg, /^ok:/);
    assert.equal(runtime.handoff?.kind, 'plan');
    assert.match(runtime.handoff!.summary, /fix foo/);
    const body = formatHandoffPayloadAsOutput(runtime.handoff!);
    assert.match(body, /## Handoff \(plan\)/);
    assert.match(body, /Assumptions/);
  });

  it('rejects outside workflow role', () => {
    assert.match(runWorkflowHandoffTool({ kind: 'note', summary: 'x' }, undefined), /error:/);
  });

  it('tool name is workflow_handoff', () => {
    assert.equal(WORKFLOW_HANDOFF_TOOL, 'workflow_handoff');
  });

  it('resolveHandoffSlotOutput expands thin summary from long final monologue', () => {
    const longPlan =
      '## Numbered plan\n' +
      Array.from({ length: 12 }, (_, i) => `${i + 1}. step detail about path/foo-${i}.ts and verify`).join(
        '\n',
      );
    assert.ok(longPlan.length > 400);
    const resolved = resolveHandoffSlotOutput(
      { kind: 'plan', summary: 'See above plan.' },
      longPlan,
    );
    assert.equal(resolved.merged, true);
    assert.match(resolved.output, /expanded slot from final message/i);
    assert.match(resolved.output, /step detail about path\/foo-0/);
    assert.match(resolved.output, /## Handoff \(plan\)/);
  });

  it('resolveHandoffSlotOutput keeps rich structured summary', () => {
    const summary =
      '1. edit a.ts\n2. edit b.ts\n3. run tests\n4. verify paths\n' +
      'details: implement feature X with acceptance Y and notes Z for reviewer.';
    const resolved = resolveHandoffSlotOutput(
      { kind: 'plan', summary },
      'ok done',
    );
    assert.equal(resolved.merged, false);
    assert.match(resolved.output, /implement feature X/);
    assert.doesNotMatch(resolved.output, /expanded slot/i);
  });

  it('resolveHandoffSlotOutput falls back to final text without tool handoff', () => {
    const resolved = resolveHandoffSlotOutput(null, 'plain body only');
    assert.equal(resolved.merged, false);
    assert.equal(resolved.output, 'plain body only');
  });
});

describe('workflow verdict needs_human', () => {
  it('parses needs_human from JSON and prose', () => {
    assert.equal(
      extractWorkflowVerdict('done\n{"verdict":"needs_human","notes":"unclear"}'),
      'needs_human',
    );
    assert.equal(
      extractWorkflowVerdict('I need needs_human — ask the user for the target API.'),
      'needs_human',
    );
    assert.equal(extractWorkflowVerdict('{"verdict":"approved"}'), 'approved');
  });
});

describe('workflow verdict normalize + pass/approve synonyms', () => {
  it('maps pass/approve synonyms to approved', () => {
    assert.equal(normalizeWorkflowVerdict('pass'), 'approved');
    assert.equal(normalizeWorkflowVerdict('passed'), 'approved');
    assert.equal(normalizeWorkflowVerdict('Approve'), 'approved');
    assert.equal(normalizeWorkflowVerdict('lgtm'), 'approved');
    assert.equal(normalizeWorkflowVerdict('approved'), 'approved');
    assert.equal(normalizeWorkflowVerdict('needs_revision'), 'needs_revision');
  });

  it('extracts pass from text and JSON (protocol risk fix)', () => {
    assert.equal(extractWorkflowVerdict('verdict: pass'), 'approved');
    assert.equal(extractWorkflowVerdict('{"verdict":"pass"}'), 'approved');
    assert.equal(extractWorkflowVerdict('{"verdict":"Approve"}'), 'approved');
    assert.equal(extractWorkflowVerdict('LGTM overall'), 'approved');
  });
});
