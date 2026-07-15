import { isAbsolute, resolve } from 'node:path';

import { saveSessionThrottled } from '../session.js';
import { runAgent } from '../agent.js';
import type { AgentStepEvent } from '../events.js';
import { configureAgentLlmBinding } from '../llm-fallback.js';
import { resolveWorkflowRoleLlmBinding } from '../llm-profiles.js';

import type { TaskBlock } from '../task-tracker.js';
import type { AgentConfig, ChatMessage, SessionFile, TaskSummaryDoc } from '../types.js';
import { getJobRegistry } from '../spawn/job-registry.js';
import type { ResolvedSpawnPreset } from '../spawn/types.js';
import {
  findReadyAndSkippable,
  settleOutgoingEdges,
  waiveOutgoingFromSkipped,
  type DagEdgeState,
} from './dag.js';
import { loadWorkflowDefinition } from './load-workflow.js';
import { resolveWorkflowRole } from './load-role.js';
import {
  evaluateWorkflowWhen,
  renderWorkflowTemplate,
  resolveSwitchOn,
} from './template.js';
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
  WorkflowNode,
  WorkflowParallel,
  WorkflowResult,
  WorkflowStep,
  WorkflowStepPhase,
  WorkflowSwitch,
} from './types.js';

export interface RunWorkflowOptions {
  workflowPath: string;
  userTask: string;
  config: AgentConfig;
  session: SessionFile;
  stream?: boolean;
  onStep?: (event: AgentStepEvent) => void;
  onWorkflowStep?: (info: {
    phase: WorkflowStepPhase;
    role: string;
    round?: number;
    input: string;
    as?: string;
  }) => void;
  onTaskComplete?: (summary: TaskSummaryDoc, taskBlock: TaskBlock) => void;
}

export function isWorkflowStep(item: WorkflowFlowItem): item is WorkflowStep {
  return (
    typeof item === 'object' &&
    item !== null &&
    'role' in item &&
    typeof (item as WorkflowStep).role === 'string' &&
    !('loop' in item) &&
    !('parallel' in item) &&
    !('switch' in item)
  );
}

export function isLoopItem(item: WorkflowFlowItem): item is { loop: WorkflowLoop } {
  return typeof item === 'object' && item !== null && 'loop' in item;
}

export function isParallelItem(
  item: WorkflowFlowItem,
): item is { parallel: WorkflowParallel } {
  return typeof item === 'object' && item !== null && 'parallel' in item;
}

export function isSwitchItem(item: WorkflowFlowItem): item is { switch: WorkflowSwitch } {
  return typeof item === 'object' && item !== null && 'switch' in item;
}

function roleNeedsShell(role: ResolvedWorkflowRole): boolean {
  return role.tools.includes('run_shell');
}

function roleNeedsWeb(role: ResolvedWorkflowRole): boolean {
  return role.tools.includes('web_fetch') || role.tools.includes('web_search');
}

function contextSlot(step: WorkflowStep): string {
  const as = step.as?.trim();
  return as || step.role;
}

function writeContextResult(
  ctx: WorkflowContext,
  keys: string[],
  output: string,
  verdict: string | undefined,
): void {
  const result = { output, verdict };
  for (const k of keys) {
    if (k) ctx.roles[k] = result;
  }
}

function roleToSpawnPreset(role: ResolvedWorkflowRole): ResolvedSpawnPreset {
  return {
    name: role.name,
    description: role.name,
    systemPrompt: role.systemPrompt,
    tools: role.tools,
    maxTurns: role.maxTurns ?? 15,
    shellPolicy: role.shellPolicy,
  };
}

function formatWhen(when: WorkflowLoop['when']): string {
  if (typeof when === 'string') return when.trim();
  return `${when.path} == '${when.eq}'`;
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
    if (!gate || !(await gate.ensureWeb(config, `workflow role "${roleName}" needs web`))) {
      if (config.abortSignal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw new Error(
        `Role "${roleName}" requires web tools. Use /web on, /approve always web, or --allow-web.`,
      );
    }
  }
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<WorkflowResult> {
  const { workflowPath, userTask, config, session, stream, onStep, onWorkflowStep } = opts;
  const definition = loadWorkflowDefinition(workflowPath, config.cwd);
  const shareSession = definition.share_session === true;
  const workflowAbs = isAbsolute(workflowPath)
    ? workflowPath
    : resolve(config.cwd, workflowPath);

  const ctx: WorkflowContext = {
    user_task: userTask,
    roles: {},
  };

  const resolvedRoles = new Map<string, ResolvedWorkflowRole>();
  for (const [name, roleConfig] of Object.entries(definition.roles)) {
    resolvedRoles.set(
      name,
      resolveWorkflowRole(name, roleConfig, workflowAbs, {
        cwd: config.cwd,
        workflowPath: workflowAbs,
        pluginConfig: config.llmPluginConfig,
      }),
    );
  }

  /** Last context slot written (for final text). */
  let lastSlot = '';

  function returnHandback(handback: WorkflowHandback): WorkflowResult {
    return buildHandbackWorkflowResult({
      workflowName: definition.name,
      sessionId: session.session_id,
      context: ctx,
      handback,
    });
  }

  /**
   * Run one role step. When `sessionClone` is set (parallel), use an isolated
   * session slice and merge tasks afterward — avoids races on current_messages.
   */
  async function runRoleStep(
    step: WorkflowStep,
    phase: WorkflowStepPhase,
    round?: number,
    sessionClone?: SessionFile,
    extraSlots?: string[],
  ): Promise<WorkflowResult | null> {
    const role = resolvedRoles.get(step.role);
    if (!role) {
      throw new Error(`Unknown workflow role: ${step.role}`);
    }

    await ensureRoleCapabilities(role, step.role, config);

    const prompt = renderWorkflowTemplate(step.input, ctx);
    const slot = contextSlot(step);
    const slots = [...new Set([slot, ...(extraSlots ?? [])].filter(Boolean))];
    const runMode = step.mode === 'job' ? 'job' : 'agent';
    onWorkflowStep?.({
      phase: runMode === 'job' ? 'job' : phase,
      role: step.role,
      round,
      input: prompt,
      as: step.as,
    });

    // ── job mode: background spawn and wait ─────────────────────────────
    if (runMode === 'job') {
      if ((config.spawnDepth ?? 0) > 0) {
        throw new Error('workflow job mode is not available inside a nested agent');
      }
      const handle = getJobRegistry().start({
        preset: roleToSpawnPreset(role),
        task: prompt,
        parentConfig: { ...config, spawnDepth: 0 },
      });
      const jobResult = await handle.promise;
      if (config.abortSignal?.aborted || jobResult.status === 'cancelled') {
        throw new DOMException('Aborted', 'AbortError');
      }
      const text = jobResult.text || jobResult.summaryLine || '';
      if (!jobResult.ok && text.startsWith('error:')) {
        // treat as agent stop for handback
        saveSessionThrottled(session, { force: true });
        return returnHandback({
          reason: 'agent_stopped',
          detail: jobResult.error ?? text,
          role: step.role,
          round,
          partial_output: text,
        });
      }
      const verdict = extractWorkflowVerdict(text);
      writeContextResult(ctx, slots, text, verdict);
      lastSlot = slot;
      saveSessionThrottled(session, { force: true });
      return null;
    }

    const roleConfig: AgentConfig = {
      ...config,
      maxTurns: role.maxTurns ?? config.maxTurns,
      toolAllowlist: role.tools.length > 0 ? role.tools : undefined,
      sessionId: session.session_id,
      spawnDepth: Math.max(1, config.spawnDepth ?? 0),
      spawnShellPolicy: role.shellPolicy,
    };

    if (config.llmPluginConfig) {
      const roleBinding = resolveWorkflowRoleLlmBinding(
        config.llmPluginConfig,
        role,
        config.llm,
      );
      configureAgentLlmBinding(roleConfig, config.llmPluginConfig, {
        profileName: role.api_profile?.trim() || roleBinding.profileName,
        model: role.model?.trim(),
      });
    } else {
      roleConfig.model = role.model ?? config.model;
    }

    const useClone = Boolean(sessionClone);
    const isolated = useClone || !shareSession;
    const activeSession = sessionClone ?? session;
    const priorMessages = session.current_messages;

    if (isolated && !useClone) {
      session.current_messages = [];
    }
    if (useClone) {
      activeSession.current_messages = [];
    }

    const result = await runAgent({
      prompt,
      config: roleConfig,
      session: activeSession,
      sessionId: session.session_id,
      stream,
      systemPrompt: role.systemPrompt,
      isolated: true,
      signal: config.abortSignal,
      onStep,
      onTaskComplete(taskSummary, taskBlock) {
        if (opts.onTaskComplete) {
          opts.onTaskComplete(taskSummary, taskBlock);
        } else if (useClone) {
          activeSession.tasks.push(taskSummary);
        } else {
          session.tasks.push(taskSummary);
        }
      },
    });

    if (result.text === '[aborted]') {
      throw new DOMException('Aborted', 'AbortError');
    }

    const stopDetail = parseAgentStopReason(result.text);
    if (stopDetail) {
      if (isolated && !useClone) {
        session.current_messages = priorMessages;
      }
      if (useClone && activeSession.tasks.length > 0) {
        session.tasks.push(...activeSession.tasks);
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

    if (useClone) {
      if (activeSession.tasks.length > 0) {
        session.tasks.push(...activeSession.tasks);
      }
    } else if (isolated) {
      session.current_messages = priorMessages;
    } else {
      session.current_messages = result.messages;
    }
    saveSessionThrottled(session, { force: true });

    const verdict = extractWorkflowVerdict(result.text);
    writeContextResult(ctx, slots, result.text, verdict);
    lastSlot = slot;
    return null;
  }

  function nodeToStep(nodeId: string, node: WorkflowNode): WorkflowStep {
    return {
      role: node.role,
      input: node.input,
      as: node.as,
      mode: node.mode,
    };
  }

  async function runDagMode(): Promise<WorkflowResult | null> {
    const edges = definition.edges ?? [];
    const edgeState = new Map<string, DagEdgeState>();
    const nodeVisits = new Map<string, number>();
    const finished = new Set<string>();
    const skipped = new Set<string>();
    const running = new Set<string>();

    let guard = 0;
    const maxIterations = Object.keys(definition.nodes ?? {}).length * 30 + 20;

    while (guard++ < maxIterations) {
      const { ready, toSkip } = findReadyAndSkippable(
        definition,
        edgeState,
        nodeVisits,
        finished,
        skipped,
        running,
      );

      for (const id of toSkip) {
        if (skipped.has(id)) continue;
        skipped.add(id);
        waiveOutgoingFromSkipped(id, edges, edgeState);
      }

      if (ready.length === 0) {
        if (toSkip.length > 0) continue;
        break;
      }

      for (const id of ready) running.add(id);

      const results = await Promise.all(
        ready.map(async (nodeId) => {
          const node = definition.nodes![nodeId]!;
          const step = nodeToStep(nodeId, node);
          const clone: SessionFile = {
            session_id: session.session_id,
            user_id: session.user_id,
            created_at: session.created_at,
            updated_at: session.updated_at,
            tasks: [],
            current_messages: [],
            llm_override: session.llm_override,
            note: session.note,
            skills_invoked: session.skills_invoked
              ? [...session.skills_invoked]
              : undefined,
          };
          const hb = await runRoleStep(
            step,
            node.mode === 'job' ? 'job' : 'dag',
            undefined,
            ready.length > 1 ? clone : undefined,
            [nodeId],
          );
          return { nodeId, hb };
        }),
      );

      for (const { nodeId, hb } of results) {
        running.delete(nodeId);
        if (hb) return hb;

        nodeVisits.set(nodeId, (nodeVisits.get(nodeId) ?? 0) + 1);
        const node = definition.nodes![nodeId]!;
        const maxV = node.max_visits ?? 1;
        const visits = nodeVisits.get(nodeId) ?? 0;

        // Mark finished for join purposes (required edges) even if re-visitable via optional edges
        finished.add(nodeId);
        settleOutgoingEdges(nodeId, edges, edgeState, ctx);

        // Allow another visit if under max_visits and a loop edge may fire later
        if (visits < maxV) {
          finished.delete(nodeId);
        }
      }
    }

    return null;
  }

  async function runFlowItems(
    items: WorkflowFlowItem[],
    phase: WorkflowStepPhase = 'role',
  ): Promise<WorkflowResult | null> {
    for (const item of items) {
      const handback = await runFlowItem(item, phase);
      if (handback) return handback;
    }
    return null;
  }

  async function runFlowItem(
    item: WorkflowFlowItem,
    outerPhase: WorkflowStepPhase = 'role',
  ): Promise<WorkflowResult | null> {
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
        const last = steps[steps.length - 1];
        const lastKey = last ? contextSlot(last) : undefined;
        const partial = lastKey ? ctx.roles[lastKey]?.output : undefined;
        return returnHandback({
          reason: 'max_rounds_exhausted',
          detail: `Condition still true after ${max_rounds} round(s): ${formatWhen(when)}`,
          role: last?.role,
          round: max_rounds,
          partial_output: partial,
        });
      }
      return null;
    }

    if (isParallelItem(item)) {
      const steps = item.parallel.steps ?? [];
      if (steps.length === 0) return null;

      // Isolated session clones so parallel runAgent calls do not race current_messages.
      const results = await Promise.all(
        steps.map(async (step) => {
          const clone: SessionFile = {
            session_id: session.session_id,
            user_id: session.user_id,
            created_at: session.created_at,
            updated_at: session.updated_at,
            tasks: [],
            current_messages: [] as ChatMessage[],
            llm_override: session.llm_override,
            note: session.note,
            skills_invoked: session.skills_invoked
              ? [...session.skills_invoked]
              : undefined,
          };
          return runRoleStep(step, 'parallel', undefined, clone);
        }),
      );
      for (const hb of results) {
        if (hb) return hb;
      }
      return null;
    }

    if (isSwitchItem(item)) {
      const key = resolveSwitchOn(item.switch.on, ctx);
      const branch =
        (key && item.switch.cases[key]) ||
        item.switch.default ||
        [];
      if (branch.length === 0) {
        return null;
      }
      return runFlowItems(branch, 'switch');
    }

    if (isWorkflowStep(item)) {
      return runRoleStep(item, outerPhase === 'switch' ? 'switch' : 'role');
    }

    throw new Error('Invalid workflow flow item (expected step, loop, parallel, or switch)');
  }

  if (definition.nodes && definition.entry) {
    const dagHb = await runDagMode();
    if (dagHb) return dagHb;
  } else {
    const early = await runFlowItems(definition.flow ?? [], 'role');
    if (early) return early;
  }

  const finalText = lastSlot ? (ctx.roles[lastSlot]?.output ?? '') : '';

  return {
    text: finalText,
    workflow: definition.name,
    context: ctx,
    sessionId: session.session_id,
  };
}
