/**
 * Shared slash **dispatch** against AgentRuntime (Web UI / non-TUI UIs).
 * Reuses parseSlashLine; never touches TUI overlays or pi SelectList.
 */

import type { AgentRuntime } from '../runner.js';
import type { WsHub } from '../web/ws-hub.js';
import { parseSlashLine, type SlashResult } from './parse.js';

export interface CommandResult {
  ok: boolean;
  message?: string;
  /** Side effects the HTTP layer should run. */
  action?:
    | { type: 'task'; text: string }
    | { type: 'workflow_run'; path: string; task: string }
    | { type: 'abort' };
  data?: unknown;
}

function llmStatus(runtime: AgentRuntime): Record<string, unknown> {
  const profiles = runtime.listSessionProfileChoices();
  const models = runtime.listSessionModelChoices();
  const activeProfile = profiles.find((p) => p.active);
  const activeModel = models.find((m) => m.active);
  return {
    profile: activeProfile?.name ?? null,
    profile_display: activeProfile?.displayName ?? null,
    model: activeModel?.model ?? runtime.config.model ?? runtime.config.llm?.model ?? null,
    armed_workflow: runtime.getArmedWorkflow(),
    loaded_skills: runtime.getLoadedSkills(),
  };
}

function broadcastLlm(hub: WsHub, runtime: AgentRuntime): void {
  hub.broadcast({ type: 'llm', ...llmStatus(runtime) });
}

function broadcastArmed(hub: WsHub, runtime: AgentRuntime, name?: string | null): void {
  hub.broadcast({
    type: 'workflow_armed',
    path: runtime.getArmedWorkflow(),
    name: name ?? null,
  });
}

/**
 * Dispatch a slash line against runtime. Returns message for UI bubble.
 * Does not start long-running tasks itself — returns action for routes to fire.
 */
export function dispatchWebCommand(
  line: string,
  runtime: AgentRuntime,
  hub: WsHub,
): CommandResult {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) {
    return { ok: false, message: 'commands must start with /' };
  }

  const result = parseSlashLine(trimmed);
  if (!result || !result.handled) {
    return { ok: false, message: `unknown command: ${trimmed.split(/\s+/)[0]}` };
  }

  if (result.llmAction) {
    return dispatchLlm(result.llmAction, runtime, hub);
  }

  if (result.armWorkflow !== undefined) {
    if (result.armWorkflow === null) {
      runtime.armWorkflow(null);
      broadcastArmed(hub, runtime, null);
      return { ok: true, message: 'Workflow OFF — normal chat' };
    }
    const path = runtime.resolveWorkflowPath(result.armWorkflow);
    if (!path) {
      return { ok: false, message: `Workflow not found: ${result.armWorkflow}` };
    }
    runtime.armWorkflow(path);
    broadcastArmed(hub, runtime, result.armWorkflow);
    return {
      ok: true,
      message: `Workflow ON: ${result.armWorkflow} — next message is the task (then auto OFF). /workflow off to cancel.`,
    };
  }

  if (result.runWorkflow) {
    const path = runtime.resolveWorkflowPath(result.runWorkflow.path);
    if (!path) {
      return { ok: false, message: `Workflow not found: ${result.runWorkflow.path}` };
    }
    if (runtime.isRunning()) {
      return { ok: false, message: 'agent is already running' };
    }
    return {
      ok: true,
      message: `Running workflow ${result.runWorkflow.path}…`,
      action: {
        type: 'workflow_run',
        path,
        task: result.runWorkflow.task,
      },
    };
  }

  if (result.runTask) {
    if (runtime.isRunning()) {
      return { ok: false, message: 'agent is already running' };
    }
    return {
      ok: true,
      message: 'Running task…',
      action: { type: 'task', text: result.runTask },
    };
  }

  if (result.stop) {
    if (runtime.isRunning()) {
      runtime.abort();
      return { ok: true, message: 'abort requested', action: { type: 'abort' } };
    }
    return { ok: true, message: 'not running' };
  }

  if (result.message?.startsWith('__') || result.message) {
    return dispatchPseudo(result, runtime, hub);
  }

  return { ok: false, message: 'command not supported in Web UI yet' };
}

function dispatchLlm(
  action: NonNullable<SlashResult['llmAction']>,
  runtime: AgentRuntime,
  hub: WsHub,
): CommandResult {
  if (runtime.isRunning()) {
    return { ok: false, message: 'cannot change LLM while agent is running' };
  }

  if (action.kind === 'profile') {
    if (action.mode === 'list') {
      return {
        ok: true,
        message: runtime.listSessionProfileChoices()
          .map((p) => `${p.active ? '* ' : '  '}${p.name}${p.available ? '' : ' (unavailable)'}`)
          .join('\n'),
        data: { profiles: runtime.listSessionProfileChoices() },
      };
    }
    if (action.mode === 'reset') {
      runtime.resetSessionLlmOverride();
      broadcastLlm(hub, runtime);
      return { ok: true, message: 'profile/model override cleared', data: llmStatus(runtime) };
    }
    if (action.name) {
      const r = runtime.setSessionLlmProfile(action.name);
      if (r.ok) broadcastLlm(hub, runtime);
      return { ok: r.ok, message: r.message, data: llmStatus(runtime) };
    }
    return { ok: false, message: 'Usage: /profile [name|reset]' };
  }

  if (action.kind === 'model') {
    if (action.mode === 'list') {
      return {
        ok: true,
        message: runtime
          .listSessionModelChoices()
          .map((m) => `${m.active ? '* ' : '  '}${m.model}`)
          .join('\n'),
        data: { models: runtime.listSessionModelChoices() },
      };
    }
    if (action.mode === 'reset') {
      runtime.resetSessionLlmModel();
      broadcastLlm(hub, runtime);
      return { ok: true, message: 'model override cleared', data: llmStatus(runtime) };
    }
    if (action.model) {
      const r = runtime.setSessionLlmModel(action.model);
      if (r.ok) broadcastLlm(hub, runtime);
      return { ok: r.ok, message: r.message, data: llmStatus(runtime) };
    }
    return { ok: false, message: 'Usage: /model [id|reset]' };
  }

  if (action.kind === 'reasoning') {
    if (action.mode === 'list') {
      return { ok: true, message: 'Use /reasoning <level|reset> (see profile reasoning_map)' };
    }
    if (action.mode === 'reset') {
      runtime.resetSessionReasoningLevel();
      broadcastLlm(hub, runtime);
      return { ok: true, message: 'reasoning override cleared', data: llmStatus(runtime) };
    }
    if (action.level) {
      const r = runtime.setSessionReasoningLevel(action.level);
      if (r.ok) broadcastLlm(hub, runtime);
      return { ok: r.ok, message: r.message, data: llmStatus(runtime) };
    }
  }

  return { ok: false, message: 'unsupported llm action' };
}

function dispatchPseudo(
  result: SlashResult,
  runtime: AgentRuntime,
  hub: WsHub,
): CommandResult {
  const msg = result.message ?? '';

  if (msg === '__help__') {
    return {
      ok: true,
      message:
        'Web slash (subset): /help /profile /model /workflow /skills /stop\n' +
        'Also use top-bar Profile/Model and side panels.',
    };
  }

  if (msg === '__workflow_list__') {
    const workflows = runtime.listWorkflowMeta();
    return {
      ok: true,
      message:
        workflows.length === 0
          ? '(no workflows)'
          : workflows
              .map((w) => `${w.name} [${w.kind}] roles=${w.roles.join(',') || '—'}`)
              .join('\n'),
      data: { workflows },
    };
  }

  if (msg === '__skills__') {
    const skills = runtime.listSkills();
    const loaded = runtime.getLoadedSkills();
    return {
      ok: true,
      message:
        skills.length === 0
          ? '(no skills)'
          : skills
              .map(
                (s) =>
                  `${loaded.includes(s.name) ? '* ' : '  '}${s.name}: ${s.description}`,
              )
              .join('\n'),
      data: { skills, loaded },
    };
  }

  const loadMatch = msg.match(/^__skill_load__:(.+)$/);
  if (loadMatch) {
    const name = loadMatch[1]!.trim();
    runtime.loadSkill(name);
    hub.broadcast({ type: 'skills', loaded: runtime.getLoadedSkills() });
    return {
      ok: true,
      message: `skill loaded: ${name}`,
      data: { loaded: runtime.getLoadedSkills() },
    };
  }

  if (msg.startsWith('__')) {
    return {
      ok: false,
      message: `command not supported in Web UI yet (${msg.split(':')[0]})`,
    };
  }

  if (result.message) {
    return { ok: true, message: result.message };
  }

  return { ok: false, message: 'command not supported in Web UI yet' };
}

export { llmStatus, broadcastLlm, broadcastArmed };
