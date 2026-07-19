import { filterMcpBindings, McpManager } from '../../plugins/mcp-manager.js';
import { resolveMcpTransportKind } from '../../plugins/mcp-transport.js';
import type { McpToolBinding } from '../../plugins/types.js';
import type { ToolDefinition } from '../../types.js';
import { isRoleToolAllowlisted } from './tool-allowlist.js';
import type { ToolProvider, ToolProviderContext, ToolResolveContext } from './types.js';

export interface McpServerStatusRow {
  name: string;
  enabled: boolean;
  transport: string | null;
  /** Safe display endpoint (url host+path or command). */
  endpoint: string | null;
  auth: 'none' | 'headers' | 'oauth_client_credentials';
  connected: boolean;
  tool_count: number;
  error?: string;
}

export interface McpStatusSnapshot {
  servers: McpServerStatusRow[];
  tools: Array<{
    apiName: string;
    serverName: string;
    toolName: string;
    description: string;
  }>;
  policy: { allow: string[]; deny: string[] };
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}

export class McpToolProvider implements ToolProvider {
  private readonly manager: McpManager;
  private bindings: McpToolBinding[] = [];
  private lastErrors = new Map<string, string>();
  private lastConfig: ToolProviderContext['pluginConfig'] | null = null;

  constructor(manager?: McpManager) {
    this.manager = manager ?? new McpManager();
  }

  async load(ctx: ToolProviderContext): Promise<void> {
    await this.shutdown();
    this.lastConfig = ctx.pluginConfig;
    this.lastErrors.clear();

    const connected: McpToolBinding[] = [];
    const policy = ctx.pluginConfig.mcp_policy ?? {};

    for (const server of ctx.pluginConfig.mcp_servers ?? []) {
      if (server.enabled === false) continue;
      try {
        const bindings = await this.manager.connect(server, ctx.cwd, {
          agentHome: ctx.pluginConfig.agent_home,
        });
        connected.push(...filterMcpBindings(bindings, policy));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastErrors.set(server.name, msg);
        console.warn(`[mcp] failed to connect ${server.name}: ${msg}`);
      }
    }

    this.bindings = connected;
  }

  async shutdown(): Promise<void> {
    await this.manager.shutdown();
    this.bindings = [];
    this.lastErrors.clear();
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

  listConnectedServers(): string[] {
    return this.manager.connectedServers();
  }

  /** Web Settings / diagnostics snapshot (no secrets). */
  getStatusSnapshot(): McpStatusSnapshot {
    const cfg = this.lastConfig;
    const tools = this.listMcpTools();
    const connected = new Set(this.manager.connectedServers());
    const toolsByServer = new Map<string, number>();
    for (const t of tools) {
      toolsByServer.set(t.serverName, (toolsByServer.get(t.serverName) ?? 0) + 1);
    }

    const servers: McpServerStatusRow[] = (cfg?.mcp_servers ?? []).map((s) => {
      const transport = resolveMcpTransportKind(s);
      const auth: McpServerStatusRow['auth'] =
        s.oauth?.type === 'client_credentials'
          ? 'oauth_client_credentials'
          : s.headers && Object.keys(s.headers).length > 0
            ? 'headers'
            : 'none';
      const endpoint = s.url?.trim()
        ? maskUrl(s.url.trim())
        : s.command?.trim()
          ? [s.command, ...(s.args ?? [])].join(' ').slice(0, 120)
          : null;
      const isConnected = connected.has(s.name);
      return {
        name: s.name,
        enabled: s.enabled !== false,
        transport,
        endpoint,
        auth,
        connected: isConnected,
        tool_count: toolsByServer.get(s.name) ?? 0,
        error: this.lastErrors.get(s.name),
      };
    });

    return {
      servers,
      tools,
      policy: {
        allow: [...(cfg?.mcp_policy?.allow ?? ['*'])],
        deny: [...(cfg?.mcp_policy?.deny ?? [])],
      },
    };
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