import { resolve } from 'node:path';

import { isCapabilityEnabled } from '../permission-gate.js';
import type { AgentConfig, ToolDefinition } from '../types.js';
import { loadAgentPluginConfig } from '../plugins/config-loader.js';
import {
  BuiltinToolProvider,
  DEFAULT_BUILTIN_TOOLS,
} from './providers/builtin-provider.js';
import { CliToolProvider } from './providers/cli-provider.js';
import { McpToolProvider } from './providers/mcp-provider.js';
import { SkillsToolProvider } from './providers/skills-provider.js';
import { SpawnToolProvider } from './providers/spawn-provider.js';
import {
  isRoleToolAllowlisted,
  isToolDenied,
  isToolPermitted,
} from './providers/tool-allowlist.js';
import type { AgentPluginConfig } from '../plugins/types.js';
import { CODE_REVIEW_DEFINITIONS } from './code-review.js';
import { EDIT_FILE_DEFINITIONS } from './edit-file.js';
import { EXPLORE_DEFINITIONS } from './explore.js';
import { READ_WRITE_DEFINITIONS } from './read-write.js';
import { RECALL_DEFINITIONS } from './recall.js';
import { SHELL_DEFINITIONS } from './shell.js';
import { SKILLS_TOOL_DEFINITIONS } from './skills-tool.js';
import { WEB_FETCH_DEFINITIONS } from './web-fetch.js';
import { WEB_SEARCH_DEFINITIONS } from './web-search.js';
import { parseToolArgsJson } from './tool-args.js';
import {
  WORKFLOW_HANDOFF_DEFINITIONS,
  WORKFLOW_HANDOFF_TOOL,
  runWorkflowHandoffTool,
} from '../workflow/handoff-tool.js';

export { DEFAULT_BUILTIN_TOOLS };

export class ToolRegistry {
  private pluginConfig: AgentPluginConfig = loadAgentPluginConfig(process.cwd());
  private readonly builtinProvider = new BuiltinToolProvider();
  private readonly mcpProvider = new McpToolProvider();
  private readonly spawnProvider = new SpawnToolProvider();
  private readonly skillsProvider = new SkillsToolProvider();
  private readonly cliProvider = new CliToolProvider();
  private initialized = false;
  private enabledBuiltin = new Set<string>();
  private registryCwd = process.cwd();

  async reinitialize(cwd: string, pluginConfig?: AgentPluginConfig): Promise<void> {
    await this.shutdownProviders();
    this.initialized = false;
    await this.initialize(cwd, pluginConfig);
  }

  async initialize(cwd: string, pluginConfig?: AgentPluginConfig): Promise<void> {
    await this.shutdownProviders();

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
      await this.builtinProvider.load(providerCtx);
      await this.mcpProvider.load(providerCtx);
      await this.spawnProvider.load(providerCtx);
      await this.skillsProvider.load(providerCtx);
      await this.cliProvider.load(providerCtx);
      this.initialized = true;
    } catch (err) {
      await this.shutdownProviders();
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

  getMcpStatus() {
    return this.mcpProvider.getStatusSnapshot();
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
    const ctx = { ...this.providerContext(), config };
    const defs: ToolDefinition[] = [];
    const seen = new Set<string>();

    this.appendProviderDefs(defs, seen, 'builtin', () =>
      this.builtinProvider.getDefinitions(ctx),
    );
    this.appendProviderDefs(defs, seen, 'spawn', () =>
      this.spawnProvider.getDefinitions(ctx),
    );
    this.appendProviderDefs(defs, seen, 'skills', () =>
      this.skillsProvider.getDefinitions(ctx),
    );
    this.appendProviderDefs(defs, seen, 'cli', () =>
      this.cliProvider.getDefinitions(ctx),
    );
    this.appendProviderDefs(defs, seen, 'mcp', () =>
      this.mcpProvider.getDefinitions(ctx),
    );

    // Workflow-only handoff tool (SPEC_WORKFLOW W4) — not a global builtin.
    if (config.workflowRole && !seen.has(WORKFLOW_HANDOFF_TOOL)) {
      if (
        isToolPermitted(
          WORKFLOW_HANDOFF_TOOL,
          config.toolAllowlist,
          config.toolDeny,
        )
      ) {
        for (const def of WORKFLOW_HANDOFF_DEFINITIONS) {
          if (!seen.has(def.function.name)) {
            seen.add(def.function.name);
            defs.push(def);
          }
        }
      }
    }

    // Eval / role denylist: drop after providers so allowlist-only code stays simple.
    if (config.toolDeny?.length) {
      return defs.filter(
        (d) => !isToolDenied(d.function.name, config.toolDeny),
      );
    }
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

      if (isToolDenied(name, config.toolDeny)) {
        return `error: tool ${name} is denied for this run`;
      }
      const allowlist = config.toolAllowlist;
      if (allowlist?.length && !isRoleToolAllowlisted(name, allowlist)) {
        return `error: tool ${name} is not allowed for this role`;
      }

      if (name === WORKFLOW_HANDOFF_TOOL) {
        return runWorkflowHandoffTool(args, config.workflowRole);
      }

      const ctx = { ...this.providerContext(), config };
      for (const provider of [
        this.skillsProvider,
        this.spawnProvider,
        this.cliProvider,
        this.builtinProvider,
        this.mcpProvider,
      ]) {
        const result = await provider.execute(name, args, ctx);
        if (result !== null) return result;
      }

      return `error: unknown tool ${name}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `error: ${msg}`;
    }
  }

  async shutdown(): Promise<void> {
    await this.shutdownProviders();
    this.initialized = false;
  }

  private appendProviderDefs(
    target: ToolDefinition[],
    seen: Set<string>,
    providerName: string,
    loadDefs: () => ToolDefinition[],
  ): void {
    try {
      this.appendUniqueDefs(target, seen, loadDefs());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`tool registry: ${providerName} getDefinitions failed: ${msg}`);
    }
  }

  private appendUniqueDefs(
    target: ToolDefinition[],
    seen: Set<string>,
    defs: ToolDefinition[],
  ): void {
    for (const def of defs) {
      const name = def.function.name;
      if (seen.has(name)) continue;
      seen.add(name);
      target.push(def);
    }
  }

  private async shutdownProviders(): Promise<void> {
    await this.builtinProvider.shutdown();
    await this.mcpProvider.shutdown();
    await this.spawnProvider.shutdown();
    await this.skillsProvider.shutdown();
    await this.cliProvider.shutdown();
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
      ...CODE_REVIEW_DEFINITIONS,
      ...(isCapabilityEnabled(config, 'shell') ? SHELL_DEFINITIONS : []),
      ...(isCapabilityEnabled(config, 'web') ? WEB_FETCH_DEFINITIONS : []),
      ...(isCapabilityEnabled(config, 'web') ? WEB_SEARCH_DEFINITIONS : []),
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