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
      return { ok: true, message: '已取消 workflow 武装，回到普通对话。' };
    }
    const path = runtime.resolveWorkflowPath(result.armWorkflow);
    if (!path) {
      return { ok: false, message: `未找到 workflow：${result.armWorkflow}` };
    }
    runtime.armWorkflow(path);
    broadcastArmed(hub, runtime, result.armWorkflow);
    return {
      ok: true,
      message: `已武装 workflow：${result.armWorkflow}。下一条消息将作为任务执行（一次性，可用 /workflow off 取消）。`,
    };
  }

  if (result.runWorkflow) {
    const path = runtime.resolveWorkflowPath(result.runWorkflow.path);
    if (!path) {
      return { ok: false, message: `未找到 workflow：${result.runWorkflow.path}` };
    }
    if (runtime.isRunning()) {
      return { ok: false, message: '当前已有任务在运行，请先中止。' };
    }
    return {
      ok: true,
      message: `正在运行 workflow：${result.runWorkflow.path}…`,
      action: {
        type: 'workflow_run',
        path,
        task: result.runWorkflow.task,
      },
    };
  }

  if (result.runTask) {
    if (runtime.isRunning()) {
      return { ok: false, message: '当前已有任务在运行，请先中止。' };
    }
    return {
      ok: true,
      message: '正在执行任务…',
      action: { type: 'task', text: result.runTask },
    };
  }

  if (result.stop) {
    if (runtime.isRunning()) {
      runtime.abort();
      return { ok: true, message: '已请求中止当前运行。', action: { type: 'abort' } };
    }
    return { ok: true, message: '当前没有在运行的任务。' };
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
        message:
          'API Profile 列表（* 当前）：\n' +
          runtime
            .listSessionProfileChoices()
            .map(
              (p) =>
                `${p.active ? '  * ' : '    '}${p.name}` +
                (p.displayName ? ` — ${p.displayName}` : '') +
                (p.available ? '' : '（不可用）'),
            )
            .join('\n'),
        data: { profiles: runtime.listSessionProfileChoices() },
      };
    }
    if (action.mode === 'reset') {
      runtime.resetSessionLlmOverride();
      broadcastLlm(hub, runtime);
      return {
        ok: true,
        message: '已清除本会话 profile/model 覆盖，恢复默认绑定。',
        data: llmStatus(runtime),
      };
    }
    if (action.name) {
      const r = runtime.setSessionLlmProfile(action.name);
      if (r.ok) broadcastLlm(hub, runtime);
      return {
        ok: r.ok,
        message: r.ok ? `已切换 profile：${action.name}\n${r.message}` : r.message,
        data: llmStatus(runtime),
      };
    }
    return { ok: false, message: '用法：/profile [名称|reset]' };
  }

  if (action.kind === 'model') {
    if (action.mode === 'list') {
      return {
        ok: true,
        message:
          '模型列表（* 当前）：\n' +
          runtime
            .listSessionModelChoices()
            .map((m) => `${m.active ? '  * ' : '    '}${m.model}`)
            .join('\n'),
        data: { models: runtime.listSessionModelChoices() },
      };
    }
    if (action.mode === 'reset') {
      runtime.resetSessionLlmModel();
      broadcastLlm(hub, runtime);
      return {
        ok: true,
        message: '已清除本会话 model 覆盖。',
        data: llmStatus(runtime),
      };
    }
    if (action.model) {
      const r = runtime.setSessionLlmModel(action.model);
      if (r.ok) broadcastLlm(hub, runtime);
      return {
        ok: r.ok,
        message: r.ok ? `已切换 model：${action.model}\n${r.message}` : r.message,
        data: llmStatus(runtime),
      };
    }
    return { ok: false, message: '用法：/model [id|reset]' };
  }

  if (action.kind === 'reasoning') {
    if (action.mode === 'list') {
      return {
        ok: true,
        message: '用法：/reasoning <level|reset>（level 见当前 profile 的 reasoning_map）',
      };
    }
    if (action.mode === 'reset') {
      runtime.resetSessionReasoningLevel();
      broadcastLlm(hub, runtime);
      return {
        ok: true,
        message: '已清除 reasoning 覆盖。',
        data: llmStatus(runtime),
      };
    }
    if (action.level) {
      const r = runtime.setSessionReasoningLevel(action.level);
      if (r.ok) broadcastLlm(hub, runtime);
      return { ok: r.ok, message: r.message, data: llmStatus(runtime) };
    }
  }

  return { ok: false, message: '不支持的 LLM 子命令' };
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
        '可用命令（Web 子集）:\n' +
        '  /help — 本说明\n' +
        '  /profile [名|reset] — 列/切 API profile\n' +
        '  /model [id|reset] — 列/切模型\n' +
        '  /workflow — 列表；/workflow !名 — 武装；/workflow off — 取消\n' +
        '  /workflow run <名> <任务> — 立即跑\n' +
        '  /skills — 列表；/skills load <名>；/skills unload <名>；/skills clear\n' +
        '  /stop — 中止当前运行\n' +
        '侧栏可管理会话与 workflow；Profile/Model 在输入框下方。',
    };
  }

  if (msg === '__workflow_list__') {
    const workflows = runtime.listWorkflowMeta();
    return {
      ok: true,
      message:
        workflows.length === 0
          ? '（当前无可用 workflow）'
          : 'Workflow 列表：\n' +
            workflows
              .map(
                (w) =>
                  `  · ${w.name} [${w.kind}] roles=${w.roles.join(',') || '—'}`,
              )
              .join('\n') +
            '\n提示：/workflow !名字 武装，或侧栏点击 arm。',
      data: { workflows },
    };
  }

  if (msg === '__skills__') {
    const skills = runtime.listSkills();
    const loaded = runtime.getLoadedSkills();
    const head =
      'Skills（* 已 load，进程级，跨 session 直到 /skills clear）：\n';
    return {
      ok: true,
      message:
        skills.length === 0
          ? '（无可用 skills）'
          : head +
            skills
              .map(
                (s) =>
                  `${loaded.includes(s.name) ? '  * ' : '    '}${s.name}: ${s.description}`,
              )
              .join('\n') +
            (loaded.length
              ? `\n已加载: ${loaded.join(', ')}`
              : '\n尚未 load 任何 skill。'),
      data: { skills, loaded },
    };
  }

  if (msg === '__skills_clear__') {
    runtime.clearLoadedSkills();
    hub.broadcast({ type: 'skills', loaded: [] });
    return {
      ok: true,
      message: '已清空本进程 load 的 skills（不影响 agent.json 默认与磁盘 memory）。',
      data: { loaded: [] },
    };
  }

  const unloadMatch = msg.match(/^__skill_unload__:(.+)$/);
  if (unloadMatch) {
    const name = unloadMatch[1]!.trim();
    const ok = runtime.unloadSkill(name);
    hub.broadcast({ type: 'skills', loaded: runtime.getLoadedSkills() });
    return {
      ok,
      message: ok
        ? `已卸载 skill: ${name}`
        : `未在已加载列表中: ${name}`,
      data: { loaded: runtime.getLoadedSkills() },
    };
  }

  const loadMatch = msg.match(/^__skill_load__:(.+)$/);
  if (loadMatch) {
    const name = loadMatch[1]!.trim();
    runtime.loadSkill(name);
    hub.broadcast({ type: 'skills', loaded: runtime.getLoadedSkills() });
    return {
      ok: true,
      message:
        `已加载 skill: ${name}\n` +
        `注意：当前为进程级注入，切换 session 不会自动卸下；用 /skills clear 或 /skills unload ${name}。`,
      data: { loaded: runtime.getLoadedSkills() },
    };
  }

  if (msg.startsWith('__')) {
    return {
      ok: false,
      message: `Web 暂不支持该命令（${msg.split(':')[0]}）。输入 /help 查看可用命令。`,
    };
  }

  if (result.message) {
    return { ok: true, message: result.message };
  }

  return { ok: false, message: 'Web 暂不支持该命令。输入 /help 查看可用命令。' };
}

export { llmStatus, broadcastLlm, broadcastArmed };
