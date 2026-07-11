import { resolve } from 'node:path';

import { isCapabilityEnabled } from '../permission-gate.js';
import type { AgentConfig, ToolDefinition } from '../types.js';
import { loadAgentPluginConfig } from '../plugins/config-loader.js';
import { McpToolProvider } from './providers/mcp-provider.js';
import { isRoleToolAllowlisted } from './providers/tool-allowlist.js';
import {
  buildLoadedSkillsSystemBlock,
  discoverSkills,
} from '../plugins/skills.js';
import type { AgentPluginConfig, SkillDefinition } from '../plugins/types.js';
import { CODE_REVIEW_DEFINITIONS, runCodeReviewTool } from './code-review.js';
import { EDIT_FILE_DEFINITIONS, runEditFileTool } from './edit-file.js';
import { EXPLORE_DEFINITIONS, runExploreTool } from './explore.js';
import { READ_WRITE_DEFINITIONS, runReadWriteTool } from './read-write.js';
import { RECALL_DEFINITIONS, runRecallTool } from './recall.js';
import { SHELL_DEFINITIONS, runShellTool } from './shell.js';
import { SKILLS_TOOL_DEFINITIONS, runSkillsTool } from './skills-tool.js';
import { WEB_FETCH_DEFINITIONS, runWebFetchTool } from './web-fetch.js';
import { WEB_SEARCH_DEFINITIONS, runWebSearchTool } from './web-search.js';
import { loadSpawnPresets } from '../spawn/load-preset.js';
import { configureSpawnSemaphore } from '../spawn/semaphore.js';
import type { ResolvedSpawnPreset } from '../spawn/types.js';
import { buildSpawnBackgroundDefinitions, runSpawnBackgroundTool } from './spawn-background.js';
import { buildSpawnDefinitions, runSpawnTool } from './spawn.js';
import { parseToolArgsJson } from './tool-args.js';

type BuiltinHandler = (
  toolName: string,
  args: Record<string, unknown>,
  config: AgentConfig,
) => Promise<string | null>;

const ALL_BUILTIN: Record<string, { defs: ToolDefinition[]; handler: BuiltinHandler }> = {
  read_file: { defs: READ_WRITE_DEFINITIONS, handler: runReadWriteTool },
  write_file: { defs: READ_WRITE_DEFINITIONS, handler: runReadWriteTool },
  edit_file: { defs: EDIT_FILE_DEFINITIONS, handler: runEditFileTool },
  grep_search: { defs: EXPLORE_DEFINITIONS, handler: runExploreTool },
  list_files: { defs: EXPLORE_DEFINITIONS, handler: runExploreTool },
  diff_file: { defs: EXPLORE_DEFINITIONS, handler: runExploreTool },
  recall_query: { defs: RECALL_DEFINITIONS, handler: runRecallTool },
  run_shell: { defs: SHELL_DEFINITIONS, handler: runShellTool },
  invoke_skill: { defs: SKILLS_TOOL_DEFINITIONS, handler: async () => null },
  web_fetch: { defs: WEB_FETCH_DEFINITIONS, handler: runWebFetchTool },
  web_search: { defs: WEB_SEARCH_DEFINITIONS, handler: runWebSearchTool },
  code_review: { defs: CODE_REVIEW_DEFINITIONS, handler: runCodeReviewTool },
};

export class ToolRegistry {
  private pluginConfig: AgentPluginConfig = loadAgentPluginConfig(process.cwd());
  private skills = new Map<string, SkillDefinition>();
  private readonly mcpProvider = new McpToolProvider();
  private initialized = false;
  private enabledBuiltin = new Set<string>();
  private spawnPresets: ResolvedSpawnPreset[] = [];
  private registryCwd = process.cwd();

  async reinitialize(cwd: string, pluginConfig?: AgentPluginConfig): Promise<void> {
    await this.mcpProvider.shutdown();
    this.initialized = false;
    await this.initialize(cwd, pluginConfig);
  }

  async initialize(cwd: string, pluginConfig?: AgentPluginConfig): Promise<void> {
    await this.mcpProvider.shutdown();

    this.registryCwd = cwd;
    this.pluginConfig = pluginConfig ?? loadAgentPluginConfig(cwd);
    this.skills = discoverSkills(this.pluginConfig.skills_dirs ?? []);
    this.enabledBuiltin = new Set(this.pluginConfig.builtin_tools ?? Object.keys(ALL_BUILTIN));

    try {
      await this.mcpProvider.load({ cwd, pluginConfig: this.pluginConfig });

      const spawnPolicy = this.pluginConfig.spawn_policy;
      this.spawnPresets = loadSpawnPresets(cwd, this.pluginConfig.spawn_presets, spawnPolicy);
      configureSpawnSemaphore(spawnPolicy?.max_parallel ?? 1);
      this.initialized = true;
    } catch (err) {
      await this.mcpProvider.shutdown();
      this.initialized = false;
      throw err;
    }
  }

  hasSpawnPresets(): boolean {
    return this.spawnPresets.length > 0;
  }

  listSpawnPresetNames(): string[] {
    return this.spawnPresets.map((p) => p.name);
  }

  getSpawnPresets(): ResolvedSpawnPreset[] {
    return this.spawnPresets;
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

  listMcpTools(): Array<{
    apiName: string;
    serverName: string;
    toolName: string;
    description: string;
  }> {
    return this.mcpProvider.listMcpTools();
  }

  getSkillSystemExtension(): string {
    const loaded = this.pluginConfig.loaded_skills ?? [];
    const selected = loaded
      .map((name) => this.skills.get(name))
      .filter((s): s is SkillDefinition => Boolean(s));
    return buildLoadedSkillsSystemBlock(selected);
  }

  private providerContext(): { cwd: string; pluginConfig: AgentPluginConfig } {
    return { cwd: this.registryCwd, pluginConfig: this.pluginConfig };
  }

  getDefinitions(config: AgentConfig): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    const seen = new Set<string>();
    const allowlist = config.toolAllowlist;

    for (const toolName of this.enabledBuiltin) {
      if (toolName === 'run_shell' && !isCapabilityEnabled(config, 'shell')) continue;
      if (toolName === 'web_fetch' && !isCapabilityEnabled(config, 'web')) continue;
      if (toolName === 'web_search' && !isCapabilityEnabled(config, 'web')) continue;
      if (!isRoleToolAllowlisted(toolName, allowlist)) continue;
      const entry = ALL_BUILTIN[toolName];
      if (!entry) continue;

      for (const def of entry.defs) {
        const name = def.function.name;
        if (!this.enabledBuiltin.has(name)) continue;
        if (!isRoleToolAllowlisted(name, allowlist)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        defs.push(def);
      }
    }

    if (this.spawnPresets.length > 0) {
      if (
        this.enabledBuiltin.has('spawn_agent') &&
        isRoleToolAllowlisted('spawn_agent', allowlist)
      ) {
        for (const def of buildSpawnDefinitions(this.spawnPresets)) {
          const name = def.function.name;
          if (seen.has(name)) continue;
          seen.add(name);
          defs.push(def);
        }
      }
      if (
        this.enabledBuiltin.has('spawn_background') &&
        isRoleToolAllowlisted('spawn_background', allowlist)
      ) {
        for (const def of buildSpawnBackgroundDefinitions(this.spawnPresets)) {
          const name = def.function.name;
          if (seen.has(name)) continue;
          seen.add(name);
          defs.push(def);
        }
      }
    }

    defs.push(
      ...this.mcpProvider.getDefinitions({
        ...this.providerContext(),
        config,
      }),
    );

    return defs;
  }

  async executeTool(
    name: string,
    argsJson: string,
    config: AgentConfig,
  ): Promise<string> {
    const parsed = parseToolArgsJson(argsJson, name);
    if (!parsed.ok) return parsed.error;
    const args = parsed.args;

    try {
      if (config.abortSignal?.aborted) {
        return '[aborted]';
      }

      const allowlist = config.toolAllowlist;
      if (allowlist?.length && !isRoleToolAllowlisted(name, allowlist)) {
        return `error: tool ${name} is not allowed for this role`;
      }

      if (name === 'invoke_skill') {
        return runSkillsTool(name, args, this.skills) ?? 'error: invoke_skill failed';
      }

      if (name === 'spawn_agent') {
        if (!this.enabledBuiltin.has('spawn_agent') || this.spawnPresets.length === 0) {
          return 'error: spawn_agent is not configured (add spawn_presets and spawn_agent to agent.json)';
        }
        const result = await runSpawnTool(name, args, config, this.spawnPresets);
        if (result !== null) return result;
      }

      if (name === 'spawn_background') {
        if (!this.enabledBuiltin.has('spawn_background') || this.spawnPresets.length === 0) {
          return 'error: spawn_background is not configured (add spawn_presets and spawn_background to agent.json)';
        }
        const result = await runSpawnBackgroundTool(name, args, config, this.spawnPresets);
        if (result !== null) return result;
      }

      const builtin = ALL_BUILTIN[name];
      if (builtin && this.enabledBuiltin.has(name)) {
        if (name === 'run_shell' && !isCapabilityEnabled(config, 'shell')) {
          const gate = config.permissionGate;
          if (!gate || !(await gate.ensureShell(config, 'run_shell'))) {
            if (config.abortSignal?.aborted) return '[aborted]';
            return 'error: run_shell is disabled. Use /shell on or approve when prompted.';
          }
        }
        if (name === 'web_fetch' && !isCapabilityEnabled(config, 'web')) {
          const gate = config.permissionGate;
          if (!gate || !(await gate.ensureWeb(config, 'web_fetch'))) {
            if (config.abortSignal?.aborted) return '[aborted]';
            return 'error: web_fetch is disabled. Use /web on or approve when prompted.';
          }
        }
        if (name === 'web_search' && !isCapabilityEnabled(config, 'web')) {
          const gate = config.permissionGate;
          if (!gate || !(await gate.ensureWeb(config, 'web_search'))) {
            if (config.abortSignal?.aborted) return '[aborted]';
            return 'error: web_search is disabled. Use /web on or approve when prompted.';
          }
        }
        const result = await builtin.handler(name, args, config);
        if (result !== null) return result;
      }

      const mcpResult = await this.mcpProvider.execute(name, args, {
        ...this.providerContext(),
        config,
      });
      if (mcpResult !== null) return mcpResult;

      return `error: unknown tool ${name}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `error: ${msg}`;
    }
  }

  async shutdown(): Promise<void> {
    await this.mcpProvider.shutdown();
    this.initialized = false;
  }
}

export const toolRegistry = new ToolRegistry();

let lastRegistryCwd: string | null = null;
let registryInitChain: Promise<void> = Promise.resolve();

async function runSerializedRegistryInit(run: () => Promise<void>): Promise<void> {
  const next = registryInitChain.then(run, run);
  registryInitChain = next.catch(() => undefined);
  await next;
}

/** Force registry + MCP reconnect for a cwd (e.g. `/cwd`). */
export async function reinitializeToolRegistry(
  cwd: string,
  pluginConfig?: AgentPluginConfig,
): Promise<ToolRegistry> {
  const resolved = resolve(cwd);
  await runSerializedRegistryInit(async () => {
    await toolRegistry.reinitialize(resolved, pluginConfig);
    lastRegistryCwd = resolved;
  });
  return toolRegistry;
}

/** Backward-compatible helpers used before initialize(). */
export async function ensureToolRegistry(
  cwd: string,
  pluginConfig?: AgentPluginConfig,
): Promise<ToolRegistry> {
  const resolved = resolve(cwd);
  if (toolRegistry.isInitialized() && lastRegistryCwd === resolved) {
    return toolRegistry;
  }
  return reinitializeToolRegistry(cwd, pluginConfig);
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
      ...EDIT_FILE_DEFINITIONS,
      ...EXPLORE_DEFINITIONS,
      ...RECALL_DEFINITIONS,
      ...SKILLS_TOOL_DEFINITIONS,
      ...(isCapabilityEnabled(config, 'shell') ? SHELL_DEFINITIONS : []),
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