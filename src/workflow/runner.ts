import { saveSession } from '../session.js';
import { runAgent, type AgentStepEvent, type RunAgentOptions } from '../agent.js';
import type { AgentConfig, SessionFile } from '../types.js';
import { loadWorkflowDefinition } from './load-workflow.js';
import { resolveWorkflowRole } from './load-role.js';
import { evaluateWorkflowWhen, renderWorkflowTemplate } from './template.js';
import { extractWorkflowVerdict } from './verdict.js';
import type {
  ResolvedWorkflowRole,
  WorkflowContext,
  WorkflowFlowItem,
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

  async function runRoleStep(step: WorkflowStep, phase: 'role' | 'loop', round?: number): Promise<void> {
    const role = resolvedRoles.get(step.role);
    if (!role) {
      throw new Error(`Unknown workflow role: ${step.role}`);
    }

    if (roleNeedsShell(role) && !config.allowShell) {
      throw new Error(
        `Role "${step.role}" requires run_shell. Restart with --allow-shell or ALLOW_SHELL=1.`,
      );
    }

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
      onStep,
      onTaskComplete(taskSummary) {
        session.tasks.push(taskSummary);
        saveSession(session);
      },
    });

    if (isolated) {
      session.current_messages = priorMessages;
    } else {
      session.current_messages = result.messages;
    }
    saveSession(session);

    const verdict = extractWorkflowVerdict(result.text);
    ctx.roles[step.role] = { output: result.text, verdict };
  }

  for (const item of definition.flow) {
    if (isLoopItem(item)) {
      const { when, max_rounds, steps } = item.loop;
      for (let round = 1; round <= max_rounds; round++) {
        if (!evaluateWorkflowWhen(when, ctx)) {
          break;
        }
        for (const step of steps) {
          await runRoleStep(step, 'loop', round);
        }
        if (!evaluateWorkflowWhen(when, ctx)) {
          break;
        }
      }
      continue;
    }

    await runRoleStep(item, 'role');
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