import { getSummaryPromptExtension } from './summary.js';
import { toolRegistry } from './tools/registry.js';
import { RECALL_DEFINITIONS } from './tools/recall.js';
import type { AgentConfig, ToolDefinition, WorkspacePromptBundle } from './types.js';
import {
  formatWorkspaceAgentMdBlock,
  loadWorkspaceAgentMd,
} from './workspace-agent-md.js';
import {
  formatWorkspaceMemoryBlock,
  loadWorkspaceMemoryInjection,
  workspaceMemoryRunMeta,
} from './workspace-memory.js';

export function loadWorkspacePromptBundle(cwd: string): WorkspacePromptBundle {
  return {
    agentMd: loadWorkspaceAgentMd(cwd),
    memory: loadWorkspaceMemoryInjection(cwd),
  };
}

export function workspacePromptRunStartMeta(bundle: WorkspacePromptBundle): {
  agent_md?: { path: string; chars: number; truncated: boolean };
  memory?: { profile_chars: number; requirements_chars: number; truncated: boolean };
} {
  const meta: {
    agent_md?: { path: string; chars: number; truncated: boolean };
    memory?: { profile_chars: number; requirements_chars: number; truncated: boolean };
  } = {};
  if (bundle.agentMd) {
    meta.agent_md = {
      path: bundle.agentMd.relativePath,
      chars: bundle.agentMd.content.length,
      truncated: bundle.agentMd.truncated,
    };
  }
  if (bundle.memory) {
    meta.memory = workspaceMemoryRunMeta(bundle.memory);
  }
  return meta;
}

function firstSentence(text: string): string {
  const idx = text.indexOf('.');
  return idx >= 0 ? text.slice(0, idx + 1).trim() : text.trim();
}

function findDefinition(defs: ToolDefinition[], name: string): ToolDefinition | undefined {
  return defs.find((d) => d.function.name === name);
}

function formatToolList(defs: ToolDefinition[]): string {
  return defs.map((d) => d.function.name).join(', ');
}

function pointerizeRecallGuidance(recallMaxKb: number): string {
  const recallLead = firstSentence(RECALL_DEFINITIONS[0].function.description);
  return (
    `Large tool outputs become [action:…] cards after a few turns; recent turns stay inline. ` +
    `${recallLead} Default full-text limit ~${recallMaxKb}KB when using action_id. ` +
    'If results are pointerized too soon for multi-file or multi-clause cross-checks, ' +
    'use context_focus to extend the inline keep window instead of recall loops.'
  );
}

function toolGuidanceLine(name: string, description: string): string | null {
  switch (name) {
    case 'web_fetch':
      return (
        `${firstSentence(description)} Respect domain allowlist in agent.json. ` +
        'If the result is [web_spill], the page is on disk as Markdown only — read with read_file(offset/limit); open source_url in a browser if conversion looks wrong.'
      );
    case 'web_search':
      return (
        `${firstSentence(description)} Cache hits skip external search. ` +
        'Pick a promising URL, then web_fetch for full content.'
      );
    case 'edit_file':
      return (
        `Prefer read_file before editing; ${firstSentence(description)} ` +
        'Quote-heavy snippets: old_string_b64/new_string_b64 (or new_content_b64).'
      );
    case 'write_file':
      return (
        `${firstSentence(description)} ` +
        'Large HTML/JSON or quote-heavy text: use content_b64; or split writes; heredoc via run_shell if allowed.'
      );
    case 'run_shell':
      return (
        `${firstSentence(description)} ` +
        'Commands with quotes/backslashes: use command_b64 (UTF-8 base64).'
      );
    case 'spawn_background':
      return (
        'spawn_background is fire-and-forget by default: job completion is pushed to this session ' +
        '(system notice / optional auto_run). Do not busy-poll or re-check the same job every turn.'
      );
    case 'context_focus':
      return (
        `${firstSentence(description)} ` +
        'Use when long tasks need multi-file / multi-clause cross-check and results would otherwise ' +
        'slide out of the inline window into [action:…] cards (recall thrash). ' +
        'Raise keep_inline_turns + ttl_turns for that window; clear=true or wait for TTL when done. ' +
        'Main agent only; prefer over repeated recall_query of the same action_ids.'
      );
    case 'invoke_skill':
    case 'spawn_agent':
      return description;
    default:
      return null;
  }
}

/** Effective model id for prompts (session override / profile already mirrored on config). */
export function resolveActiveModelLabel(config: AgentConfig): string {
  const model = (config.llm?.model ?? config.model)?.trim();
  if (!model) return 'unknown';
  const profile =
    config.llm?.displayName?.trim() ||
    config.llm?.profileName?.trim() ||
    '';
  return profile ? `${model} (${profile})` : model;
}

/**
 * Framework-bound conventions formerly duplicated in Agent.md.example.
 * Always injected so Agent.md can stay project-specific within its char budget.
 * Keep protocol/tool names English (see docs/PLAN_PROMPT_ZH.md).
 */
export function buildFrameworkWorkspaceHints(): string {
  return [
    '',
    '## Framework workspace conventions',
    '(Built-in — do not repeat in Agent.md; use Agent.md for project-only rules.)',
    '',
    '### Skills',
    '- Use `invoke_skill` for full playbooks instead of pasting long checklists into Agent.md.',
    '- Call with skill name + optional focus query when a specialized procedure is needed.',
    '',
    '### Cross-session memory',
    '- User notes: `.agent/memory/` (`profile.md` / `requirements.md` may be injected every run).',
    '- `archives.md` is an index only — use `grep_search` / `read_file` to open details.',
    '- TUI: `/memory` status | init | show | paths.',
    '',
    '### Optional artifacts',
    '- `.agent/plan.md` — multi-file or long tasks: goal / steps / risks (agent-maintained).',
    '- `specs/` — feature specs with acceptance criteria when doing spec-first work.',
    // Work style (plan-first / grill / small-fix) lives in Agent.md — not framework.
  ].join('\n');
}

/** Default system prompt; tool names and hints come from the live tool registry. */
export function buildSystemPrompt(config: AgentConfig): string {
  const recallKb = Math.round((config.recallAutoFullMaxChars ?? 24_000) / 1000);
  const skillExt = toolRegistry.isInitialized() ? toolRegistry.getSkillSystemExtension() : '';

  const defs = toolRegistry.isInitialized()
    ? toolRegistry.getDefinitions(config)
    : [];

  const toolList =
    defs.length > 0
      ? formatToolList(defs)
      : 'read_file, write_file, edit_file, grep_search, list_files, diff_file, recall_query, invoke_skill';

  const modelLabel = resolveActiveModelLabel(config);

  // Identity/behavior in Chinese for demo readability; tool names & usage stay English.
  const lines: string[] = [
    '你是一个精简的编程助手（learning demo 底座）。',
    `当前模型: ${modelLabel}.`,
    '',
    `Builtin tools: ${toolList}；MCP tools 形如 mcp_<server>_<tool>.`,
  ];

  // Protocol/tool mechanics only — style belongs in Agent.md.
  for (const name of [
    'web_search',
    'web_fetch',
    'write_file',
    'edit_file',
    'context_focus',
    'invoke_skill',
    'spawn_agent',
    'spawn_background',
  ] as const) {
    const def = findDefinition(defs, name);
    if (!def) continue;
    const hint = toolGuidanceLine(name, def.function.description);
    if (hint) lines.push(`- ${hint}`);
  }

  lines.push('- 简要说明你在做什么（Explain briefly what you are doing）。');
  lines.push('- 任务完成后用简短 summary 回复，并 stop calling tools。');
  lines.push(`- ${pointerizeRecallGuidance(recallKb)}`);
  lines.push('- If recall marks stale, use read_file for the latest file content.');
  if (findDefinition(defs, 'spawn_background')) {
    lines.push(
      '- Background jobs: after spawn_background (wait=false), continue other work; ' +
        'completion is delivered to this session — do not poll job status in a loop.',
    );
  }

  const base = lines.join('\n') + buildFrameworkWorkspaceHints();
  const bundle = config.workspacePrompt ?? loadWorkspacePromptBundle(config.cwd);
  const agentMdBlock = bundle.agentMd ? formatWorkspaceAgentMdBlock(bundle.agentMd) : '';
  const memoryBlock = bundle.memory ? formatWorkspaceMemoryBlock(bundle.memory) : '';

  // Order: base+framework < Agent.md (project) < memory < loaded_skills < summary extension
  return base + agentMdBlock + memoryBlock + skillExt + getSummaryPromptExtension();
}