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
  runWorkflowHandoffTool,
  type WorkflowRoleRuntime,
} from '../src/workflow/handoff-tool.js';
import { extractWorkflowVerdict } from '../src/workflow/verdict.js';

describe('workflow envelope (W4 isolation)', () => {
  it('injects handoff importance without voiding language', () => {
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
    assert.match(env, /stop calling tools/i);
    assert.match(env, /parent session/i);
    assert.doesNotMatch(env, /voided|作废|session will be deleted/i);
    assert.match(env, /workflow_handoff/);
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
