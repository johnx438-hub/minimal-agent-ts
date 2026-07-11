import { filterMcpBindings, McpManager } from '../../plugins/mcp-manager.js';
import type { McpToolBinding } from '../../plugins/types.js';
import type { ToolDefinition } from '../../types.js';
import { isRoleToolAllowlisted } from './tool-allowlist.js';
import type { ToolProvider, ToolProviderContext, ToolResolveContext } from './types.js';

export class McpToolProvider implements ToolProvider {
  private readonly manager: McpManager;
  private bindings: McpToolBinding[] = [];

  constructor(manager?: McpManager) {
    this.manager = manager ?? new McpManager();
  }

  async load(ctx: ToolProviderContext): Promise<void> {
    await this.shutdown();

    const connected: McpToolBinding[] = [];
    const policy = ctx.pluginConfig.mcp_policy ?? {};

    for (const server of ctx.pluginConfig.mcp_servers ?? []) {
      try {
        const bindings = await this.manager.connect(server, ctx.cwd);
        connected.push(...filterMcpBindings(bindings, policy));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp] failed to connect ${server.name}: ${msg}`);
      }
    }

    this.bindings = connected;
  }

  async shutdown(): Promise<void> {
    await this.manager.shutdown();
    this.bindings = [];
  }

  listMcpTools(): Array<{
    apiName: string;
    serverName: string;
    toolName: string;
    description: string;
  }> {
    return this.bindings.map((b) => ({
      apiName: b.apiName,
      serverName: b.serverName,
      toolName: b.toolName,
      description: b.description,
    }));
  }

  getDefinitions(ctx: ToolResolveContext): ToolDefinition[] {
    const allowlist = ctx.config.toolAllowlist;
    const defs: ToolDefinition[] = [];

    for (const binding of this.bindings) {
      if (!isRoleToolAllowlisted(binding.apiName, allowlist)) continue;
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

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolResolveContext,
  ): Promise<string | null> {
    const binding = this.bindings.find((b) => b.apiName === name);
    if (!binding) return null;
    return binding.call(args, ctx.config.abortSignal);
  }

  /** Test hook: inject bindings without connecting MCP servers. */
  setBindingsForTests(bindings: McpToolBinding[]): void {
    this.bindings = bindings;
  }
}