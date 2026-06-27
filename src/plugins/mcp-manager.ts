import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { McpPolicy, McpServerConfig, McpToolBinding } from './types.js';

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return name === pattern;
}

export function isToolAllowed(apiName: string, policy: McpPolicy): boolean {
  const deny = policy.deny ?? [];
  for (const pattern of deny) {
    if (matchesPattern(apiName, pattern)) return false;
  }

  const allow = policy.allow ?? ['*'];
  for (const pattern of allow) {
    if (matchesPattern(apiName, pattern)) return true;
  }

  return false;
}

function formatToolResult(result: Record<string, unknown>): string {
  if ('toolResult' in result && result.toolResult !== undefined) {
    const tr = result.toolResult;
    const text = typeof tr === 'string' ? tr : JSON.stringify(tr);
    return result.isError === true ? `error: ${text}` : text;
  }

  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const isError = result.isError === true;

  if (!content || content.length === 0) {
    return isError ? 'error: empty MCP tool result' : '(no output)';
  }

  const text = content
    .map((block) => {
      if (block.type === 'text') return block.text ?? '';
      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join('\n');

  return isError ? `error: ${text}` : text;
}

export class McpManager {
  private clients = new Map<string, Client>();

  async connect(server: McpServerConfig, cwd: string): Promise<McpToolBinding[]> {
    if (server.enabled === false) return [];

    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: server.env,
      cwd: server.cwd ?? cwd,
      stderr: 'pipe',
    });

    const client = new Client({ name: 'minimal-agent-ts', version: '0.1.0' });
    await client.connect(transport);
    this.clients.set(server.name, client);

    const listed = await client.listTools();
    const bindings: McpToolBinding[] = [];

    for (const tool of listed.tools) {
      const apiName = `mcp_${sanitizeName(server.name)}_${sanitizeName(tool.name)}`;
      const inputSchema = (tool.inputSchema ?? {
        type: 'object',
        properties: {},
      }) as Record<string, unknown>;

      bindings.push({
        apiName,
        serverName: server.name,
        toolName: tool.name,
        description: tool.description ?? `MCP tool ${tool.name} from ${server.name}`,
        parameters: inputSchema,
        call: async (args) => {
          const active = this.clients.get(server.name);
          if (!active) return `error: MCP server disconnected: ${server.name}`;
          const result = await active.callTool({ name: tool.name, arguments: args });
          return formatToolResult(result);
        },
      });
    }

    return bindings;
  }

  async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}

export function filterMcpBindings(
  bindings: McpToolBinding[],
  policy: McpPolicy,
): McpToolBinding[] {
  return bindings.filter((b) => isToolAllowed(b.apiName, policy));
}