import type { AgentPluginConfig } from '../../plugins/types.js';
import type { AgentConfig, ToolDefinition } from '../../types.js';

export interface ToolProviderContext {
  cwd: string;
  pluginConfig: AgentPluginConfig;
  /** Resolved builtin_tools allowlist from ToolRegistry (includes defaults). */
  enabledBuiltin?: ReadonlySet<string>;
}

export interface ToolResolveContext extends ToolProviderContext {
  config: AgentConfig;
}

export interface ToolProvider {
  load(ctx: ToolProviderContext): Promise<void>;
  shutdown(): Promise<void>;
  getDefinitions(ctx: ToolResolveContext): ToolDefinition[];
  /** Return null when this provider does not own the tool. */
  execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolResolveContext,
  ): Promise<string | null>;
}