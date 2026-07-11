import { resolve } from 'node:path';

import { isCapabilityEnabled } from '../permission-gate.js';
import type { AgentConfig, ToolDefinition } from '../types.js';
import { loadAgentPluginConfig } from '../plugins/config-loader.js';
import { CliToolProvider } from './providers/cli-provider.js';
import { McpToolProvider } from './providers/mcp-provider.js';
import { SkillsToolProvider } from './providers/skills-provider.js';
import { SpawnToolProvider } from './providers/spawn-provider.js';
import { isRoleToolAllowlisted } from './providers/tool-allowlist.js';
import type { AgentPluginConfig } from '../plugins/types.js';
import { CODE_REVIEW_DEFINITIONS, runCodeReviewTool } from './code-review.js';
import { EDIT_FILE_DEFINITIONS, runEditFileTool } from './edit-file.js';
import { EXPLORE_DEFINITIONS, runExploreTool } from './explore.js';
import { READ_WRITE_DEFINITIONS, runReadWriteTool } from './read-write.js';
import { RECALL_DEFINITIONS, runRecallTool } from './recall.js';
import { SHELL_DEFINITIONS, runShellTool } from './shell.js';
import { SKILLS_TOOL_DEFINITIONS } from './skills-tool.js';
import { WEB_FETCH_DEFINITIONS, runWebFetchTool } from './web-fetch.js';
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
  web_fetch: { defs: WEB_FETCH_DEFINITIONS, handler: runWebFetchTool },
  code_review: { defs: CODE_REVIEW_DEFINITIONS, handler: runCodeReviewTool },
};

const DEFAULT_BUILTIN_TOOLS = [
  ...Object.keys(ALL_BUILTIN),
  'invoke_skill',
  'web_search',
] as const;

export class ToolRegistry {
  private pluginConfig: AgentPluginConfig = loadAgentPluginConfig(process.cwd());
  private readonly mcpProvider = new McpToolProvider();
  private readonly spawnProvider = new SpawnToolProvider();
  private readonly skillsProvider = new SkillsToolProvider();
  private readonly cliProvider = new CliToolProvider();
  private initialized = false;
  private enabledBuiltin = new Set<string>();
  private registryCwd = process.cwd();

  async reinitialize(cwd: string, pluginConfig?: AgentPluginConfig): Promise<void> {
    await this.mcpProvider.shutdown();
    await this.spawnProvider.shutdown();
    await this.skillsProvider.shutdown();
    await this.cliProvider.shutdown();
    this.initialized = false;
    await this.initialize(cwd, pluginConfig);
  }

  async initialize(cwd: string, pluginConfig?: AgentPluginConfig): Promise<void> {
    await this.mcpProvider.shutdown();
    await this.spawnProvider.shutdown();
    await this.skillsProvider.shutdown();
    await this.cliProvider.shutdown();

    this.registryCwd = cwd;
    this.pluginConfig = pluginConfig ?? loadAgentPluginConfig(cwd);
    this.enabledBuiltin = new Set(
      this.pluginConfig.builtin_tools ?? DEFAULT_BUILTIN_TOOLS,
    );

    try {
      const providerCtx = {
        cwd,
        pluginConfig: this.pluginConfig,
        enabledBuiltin: this.enabledBuiltin,
      };
      await this.mcpProvider.load(providerCtx);
      await this.spawnProvider.load(providerCtx);
      await this.skillsProvider.load(providerCtx);
      await this.cliProvider.load(providerCtx);
      this.initialized = true;
    } catch (err) {
      await this.mcpProvider.shutdown();
      await this.spawnProvider.shutdown();
      await this.skillsProvider.shutdown();
      await this.cliProvider.shutdown();
      this.initialized = false;
      throw err;
    }
  }

  hasSpawnPresets(): boolean {
    return this.spawnProvider.hasSpawnPresets();
  }

  listSpawnPresetNames(): string[] {
    return this.spawnProvider.listSpawnPresetNames();
  }

  getSpawnPresets(): ReturnType<SpawnToolProvider['getSpawnPresets']> {
    return this.spawnProvider.getSpawnPresets();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getPluginConfig(): AgentPluginConfig {
    return this.pluginConfig;
  }

  listSkillNames(): string[] {
    return this.skillsProvider.listSkillNames();
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
    return this.skillsProvider.getSkillSystemExtension(
      this.pluginConfig.loaded_skills,
    );
  }

  private providerContext(): {
    cwd: string;
    pluginConfig: AgentPluginConfig;
    enabledBuiltin: ReadonlySet<string>;
  } {
    return {
      cwd: this.registryCwd,
      pluginConfig: this.pluginConfig,
      enabledBuiltin: this.enabledBuiltin,
    };
  }

  getDefinitions(config: AgentConfig): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    const seen = new Set<string>();
    const allowlist = config.toolAllowlist;

    for (const toolName of this.enabledBuiltin) {
      if (toolName === 'run_shell' && !isCapabilityEnabled(config, 'shell')) continue;
      if (toolName === 'web_fetch' && !isCapabilityEnabled(config, 'web')) continue;
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

    for (const def of this.spawnProvider.getDefinitions({
      ...this.providerContext(),
      config,
    })) {
      const name = def.function.name;
      if (seen.has(name)) continue;
      seen.add(name);
      defs.push(def);
    }

    for (const def of this.skillsProvider.getDefinitions({
      ...this.providerContext(),
      config,
    })) {
      const name = def.function.name;
      if (seen.has(name)) continue;
      seen.add(name);
      defs.push(def);
    }

    for (const def of this.cliProvider.getDefinitions({
      ...this.providerContext(),
      config,
    })) {
      const name = def.function.name;
      if (seen.has(name)) continue;
      seen.add(name);
      defs.push(def);
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

      const skillsResult = await this.skillsProvider.execute(name, args, {
        ...this.providerContext(),
        config,
      });
      if (skillsResult !== null) return skillsResult;

      const spawnResult = await this.spawnProvider.execute(name, args, {
        ...this.providerContext(),
        config,
      });
      if (spawnResult !== null) return spawnResult;

      const cliResult = await this.cliProvider.execute(name, args, {
        ...this.providerContext(),
        config,
      });
      if (cliResult !== null) return cliResult;

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
    await this.spawnProvider.shutdown();
    await this.skillsProvider.shutdown();
    await this.cliProvider.shutdown();
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