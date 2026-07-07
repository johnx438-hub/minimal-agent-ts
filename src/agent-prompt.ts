import { getSummaryPromptExtension } from './summary.js';
import { toolRegistry } from './tools/registry.js';
import { RECALL_DEFINITIONS } from './tools/recall.js';
import type { AgentConfig, ToolDefinition } from './types.js';
import {
  formatWorkspaceAgentMdBlock,
  loadWorkspaceAgentMd,
} from './workspace-agent-md.js';

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
    `${recallLead} Default full-text limit ~${recallMaxKb}KB when using action_id.`
  );
}

function toolGuidanceLine(name: string, description: string): string | null {
  switch (name) {
    case 'web_fetch':
      return (
        `${firstSentence(description)} Respect domain allowlist in agent.json. ` +
        'If the result is [web_spill], the page is on disk as Markdown only — read with read_file(offset/limit); open source_url in a browser if conversion looks wrong.'
      );
    case 'edit_file':
      return `Prefer read_file before editing; ${firstSentence(description)}`;
    case 'invoke_skill':
    case 'spawn_agent':
      return description;
    default:
      return null;
  }
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

  const lines: string[] = [
    'You are a minimal coding assistant in a learning demo.',
    '',
    `You have builtin tools (${toolList}) plus any MCP tools exposed as mcp_<server>_<tool>.`,
  ];

  for (const name of ['web_fetch', 'edit_file', 'invoke_skill', 'spawn_agent'] as const) {
    const def = findDefinition(defs, name);
    if (!def) continue;
    const hint = toolGuidanceLine(name, def.function.description);
    if (hint) lines.push(`- ${hint}`);
  }

  lines.push('- Explain briefly what you are doing.');
  lines.push('- When the task is done, reply with a short summary and stop calling tools.');
  lines.push(`- ${pointerizeRecallGuidance(recallKb)}`);
  lines.push('- If recall marks stale, use read_file for the latest file content.');

  const base = lines.join('\n');
  const agentMd = loadWorkspaceAgentMd(config.cwd);
  const agentMdBlock = agentMd ? formatWorkspaceAgentMdBlock(agentMd) : '';

  // Order: base < Agent.md < loaded_skills (agent.json) < summary JSON extension
  return base + agentMdBlock + skillExt + getSummaryPromptExtension();
}