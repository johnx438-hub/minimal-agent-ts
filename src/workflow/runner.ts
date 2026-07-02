import { saveSessionThrottled } from '../session.js';
import { runAgent } from '../agent.js';
import type { AgentStepEvent } from '../events.js';

import type { AgentConfig, SessionFile } from '../types.js';
import { loadWorkflowDefinition } from './load-workflow.js';
import { resolveWorkflowRole } from './load-role.js';
import { evaluateWorkflowWhen, renderWorkflowTemplate } from './template.js';
import { extractWorkflowVerdict } from './verdict.js';
import {
  buildHandbackWorkflowResult,
  classifyAgentStopReason,
  parseAgentStopReason,
} from './handback.js';
import type {
  ResolvedWorkflowRole,
  WorkflowContext,
  WorkflowFlowItem,
  WorkflowHandback,
  WorkflowLoop,
  WorkflowResult,
  WorkflowStep,
} from './types.js';

export interface RunWorkflowOptions {
  workflowPath: string;
  userTask: string;
  config: AgentConfig;
  session: SessionFile;
  stream?: boolean;
  onStep?: (event: AgentStepEvent) => void;
  onWorkflowStep?: (info: {
    phase: 'role' | 'loop';
    role: string;
    round?: number;
    input: string;
  }) => void;
}

function isLoopItem(item: WorkflowFlowItem): item is { loop: WorkflowLoop } {
  return 'loop' in item;
}

function roleNeedsShell(role: ResolvedWorkflowRole): boolean {
  return role.tools.includes('run_shell');
}

function roleNeedsWeb(role: ResolvedWorkflowRole): boolean {
  return role.tools.includes('web_fetch');
}

async function ensureRoleCapabilities(
  role: ResolvedWorkflowRole,
  roleName: string,
  config: AgentConfig,
): Promise<void> {
  if (config.abortSignal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const gate = config.permissionGate;

  if (roleNeedsShell(role)) {
    if (!gate || !(await gate.ensureShell(config, `workflow role "${roleName}" needs run_shell`))) {
      if (config.abortSignal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw new Error(
        `Role "${roleName}" requires run_shell. Use /shell on, /approve always shell, or --allow-shell.`,
      );
    }
  }

  if (roleNeedsWeb(role)) {
    if (!gate || !(await gate.ensureWeb(config, `workflow role "${roleName}" needs web_fetch`))) {
      if (config.abortSignal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw new Error(
        `Role "${roleName}" requires web_fetch. Use /web on, /approve always web, or --allow-web.`,
      );
    }
  }
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<WorkflowResult> {
  const { workflowPath, userTask, config, session, stream, onStep, onWorkflowStep } = opts;
  const definition = loadWorkflowDefinition(workflowPath, config.cwd);
  const shareSession = definition.share_session === true;

  const ctx: WorkflowContext = {
    user_task: userTask,
    roles: {},
  };

  const resolvedRoles = new Map<string, ResolvedWorkflowRole>();
  for (const [name, roleConfig] of Object.entries(definition.roles)) {
    resolvedRoles.set(name, resolveWorkflowRole(name, roleConfig, workflowPath));
  }

  function returnHandback(handback: WorkflowHandback): WorkflowResult {
    return buildHandbackWorkflowResult({
      workflowName: definition.name,
      sessionId: session.session_id,
      context: ctx,
      handback,
    });
  }

  async function runRoleStep(
    step: WorkflowStep,
    phase: 'role' | 'loop',
    round?: number,
  ): Promise<WorkflowResult | null> {
    const role = resolvedRoles.get(step.role);
    if (!role) {
      throw new Error(`Unknown workflow role: ${step.role}`);
    }

    await ensureRoleCapabilities(role, step.role, config);

    const prompt = renderWorkflowTemplate(step.input, ctx);
    onWorkflowStep?.({ phase, role: step.role, round, input: prompt });

    const roleConfig: AgentConfig = {
      ...config,
      model: role.model ?? config.model,
      maxTurns: role.maxTurns ?? config.maxTurns,
      toolAllowlist: role.tools.length > 0 ? role.tools : undefined,
      sessionId: session.session_id,
    };

    const isolated = !shareSession;
    const priorMessages = session.current_messages;

    if (isolated) {
      session.current_messages = [];
    }

    const result = await runAgent({
      prompt,
      config: roleConfig,
      session,
      sessionId: session.session_id,
      stream,
      systemPrompt: role.systemPrompt,
      isolated,
      signal: config.abortSignal,
      onStep,
      onTaskComplete(taskSummary) {
        session.tasks.push(taskSummary);
      },
    });

    if (result.text === '[aborted]') {
      throw new DOMException('Aborted', 'AbortError');
    }

    const stopDetail = parseAgentStopReason(result.text);
    if (stopDetail) {
      if (isolated) {
        session.current_messages = priorMessages;
      }
      saveSessionThrottled(session, { force: true });
      return returnHandback({
        reason: classifyAgentStopReason(stopDetail),
        detail: stopDetail,
        role: step.role,
        round,
        partial_output: result.text,
      });
    }

    if (isolated) {
      session.current_messages = priorMessages;
    } else {
      session.current_messages = result.messages;
    }
    saveSessionThrottled(session, { force: true });

    const verdict = extractWorkflowVerdict(result.text);
    ctx.roles[step.role] = { output: result.text, verdict };
    return null;
  }

  for (const item of definition.flow) {
    if (isLoopItem(item)) {
      const { when, max_rounds, steps } = item.loop;
      for (let round = 1; round <= max_rounds; round++) {
        if (!evaluateWorkflowWhen(when, ctx)) {
          break;
        }
        for (const step of steps) {
          const handback = await runRoleStep(step, 'loop', round);
          if (handback) return handback;
        }
        if (!evaluateWorkflowWhen(when, ctx)) {
          break;
        }
      }

      if (evaluateWorkflowWhen(when, ctx)) {
        const lastRole = steps[steps.length - 1]?.role;
        const partial = lastRole ? ctx.roles[lastRole]?.output : undefined;
        return returnHandback({
          reason: 'max_rounds_exhausted',
          detail: `Condition still true after ${max_rounds} round(s): ${when.trim()}`,
          role: lastRole,
          round: max_rounds,
          partial_output: partial,
        });
      }
      continue;
    }

    const handback = await runRoleStep(item, 'role');
    if (handback) return handback;
  }

  const flowRoles = definition.flow.flatMap((item) =>
    isLoopItem(item) ? item.loop.steps.map((s) => s.role) : [item.role],
  );
  const lastRoleName = flowRoles[flowRoles.length - 1];
  const finalText = ctx.roles[lastRoleName]?.output ?? '';

  return {
    text: finalText,
    workflow: definition.name,
    context: ctx,
    sessionId: session.session_id,
  };
}