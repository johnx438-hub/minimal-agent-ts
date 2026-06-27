import type { AgentConfig, ToolDefinition } from '../types.js';
import { loadAgentPluginConfig } from '../plugins/config-loader.js';
import { filterMcpBindings, McpManager } from '../plugins/mcp-manager.js';
import {
  buildLoadedSkillsSystemBlock,
  discoverSkills,
} from '../plugins/skills.js';
import type { AgentPluginConfig, McpToolBinding, SkillDefinition } from '../plugins/types.js';
import { EXPLORE_DEFINITIONS, runExploreTool } from './explore.js';
import { READ_WRITE_DEFINITIONS, runReadWriteTool } from './read-write.js';
import { RECALL_DEFINITIONS, runRecallTool } from './recall.js';
import { SHELL_DEFINITIONS, runShellTool } from './shell.js';
import { SKILLS_TOOL_DEFINITIONS, runSkillsTool } from './skills-tool.js';

type BuiltinHandler = (
  toolName: string,
  args: Record<string, unknown>,
  config: AgentConfig,
) => Promise<string | null>;

const ALL_BUILTIN: Record<string, { defs: ToolDefinition[]; handler: BuiltinHandler }> = {
  read_file: { defs: READ_WRITE_DEFINITIONS, handler: runReadWriteTool },
  write_file: { defs: READ_WRITE_DEFINITIONS, handler: runReadWriteTool },
  grep_search: { defs: EXPLORE_DEFINITIONS, handler: runExploreTool },
  list_files: { defs: EXPLORE_DEFINITIONS, handler: runExploreTool },
  diff_file: { defs: EXPLORE_DEFINITIONS, handler: runExploreTool },
  recall_query: { defs: RECALL_DEFINITIONS, handler: runRecallTool },
  run_shell: { defs: SHELL_DEFINITIONS, handler: runShellTool },
  invoke_skill: { defs: SKILLS_TOOL_DEFINITIONS, handler: async () => null },
};

export class ToolRegistry {
  private pluginConfig: AgentPluginConfig = loadAgentPluginConfig(process.cwd());
  private skills = new Map<string, SkillDefinition>();
  private mcpBindings: McpToolBinding[] = [];
  private mcpManager = new McpManager();
  private initialized = false;
  private enabledBuiltin = new Set<string>();

  async initialize(cwd: string, pluginConfig?: AgentPluginConfig): Promise<void> {
    this.pluginConfig = pluginConfig ?? loadAgentPluginConfig(cwd);
    this.skills = discoverSkills(this.pluginConfig.skills_dirs ?? []);
    this.mcpBindings = [];

    const servers = this.pluginConfig.mcp_servers ?? [];
    for (const server of servers) {
      try {
        const bindings = await this.mcpManager.connect(server, cwd);
        const allowed = filterMcpBindings(bindings, this.pluginConfig.mcp_policy ?? {});
        this.mcpBindings.push(...allowed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp] failed to connect ${server.name}: ${msg}`);
      }
    }

    this.enabledBuiltin = new Set(this.pluginConfig.builtin_tools ?? Object.keys(ALL_BUILTIN));
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getPluginConfig(): AgentPluginConfig {
    return this.pluginConfig;
  }

  listSkillNames(): string[] {
    return [...this.skills.keys()];
  }

  getSkillSystemExtension(): string {
    const loaded = this.pluginConfig.loaded_skills ?? [];
    const selected = loaded
      .map((name) => this.skills.get(name))
      .filter((s): s is SkillDefinition => Boolean(s));
    return buildLoadedSkillsSystemBlock(selected);
  }

  getDefinitions(config: AgentConfig): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    const seen = new Set<string>();

    for (const toolName of this.enabledBuiltin) {
      if (toolName === 'run_shell' && !config.allowShell) continue;
      const entry = ALL_BUILTIN[toolName];
      if (!entry) continue;

      for (const def of entry.defs) {
        const name = def.function.name;
        if (!this.enabledBuiltin.has(name)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        defs.push(def);
      }
    }

    for (const binding of this.mcpBindings) {
      defs.push({
        type: 'function',
        function: {
          name: binding.apiName,
          description: `[MCP:${binding.serverName}] ${binding.description}`,
          parameters: binding.parameters,
        },
      });
    }

    return defs;
  }

  async executeTool(
    name: string,
    argsJson: string,
    config: AgentConfig,
  ): Promise<string> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      return `error: invalid JSON arguments: ${argsJson}`;
    }

    try {
      if (name === 'invoke_skill') {
        return runSkillsTool(name, args, this.skills) ?? 'error: invoke_skill failed';
      }

      const builtin = ALL_BUILTIN[name];
      if (builtin && this.enabledBuiltin.has(name)) {
        if (name === 'run_shell' && !config.allowShell) {
          return 'error: run_shell is disabled. Set ALLOW_SHELL=1 to enable.';
        }
        const result = await builtin.handler(name, args, config);
        if (result !== null) return result;
      }

      const mcp = this.mcpBindings.find((b) => b.apiName === name);
      if (mcp) {
        return await mcp.call(args);
      }

      return `error: unknown tool ${name}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `error: ${msg}`;
    }
  }

  async shutdown(): Promise<void> {
    await this.mcpManager.shutdown();
    this.initialized = false;
  }
}

export const toolRegistry = new ToolRegistry();

/** Backward-compatible helpers used before initialize(). */
export async function ensureToolRegistry(
  cwd: string,
  pluginConfig?: AgentPluginConfig,
): Promise<ToolRegistry> {
  if (!toolRegistry.isInitialized()) {
    await toolRegistry.initialize(cwd, pluginConfig);
  }
  return toolRegistry;
}

export async function executeTool(
  name: string,
  argsJson: string,
  config: AgentConfig,
): Promise<string> {
  await ensureToolRegistry(config.cwd);
  return toolRegistry.executeTool(name, argsJson, config);
}

export function getToolDefinitions(config: AgentConfig): ToolDefinition[] {
  if (!toolRegistry.isInitialized()) {
    return [
      ...READ_WRITE_DEFINITIONS,
      ...EXPLORE_DEFINITIONS,
      ...RECALL_DEFINITIONS,
      ...SKILLS_TOOL_DEFINITIONS,
      ...(config.allowShell ? SHELL_DEFINITIONS : []),
    ];
  }
  return toolRegistry.getDefinitions(config);
}

/** @deprecated Use getToolDefinitions(config) after registry init. */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...READ_WRITE_DEFINITIONS,
  ...EXPLORE_DEFINITIONS,
  ...RECALL_DEFINITIONS,
  ...SKILLS_TOOL_DEFINITIONS,
  ...SHELL_DEFINITIONS,
];