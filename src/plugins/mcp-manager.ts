import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import {
  closeMcpTransport,
  createMcpClientTransport,
  validateMcpServerConfig,
} from './mcp-transport.js';
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

interface McpConnection {
  client: Client;
  transport: Transport;
}

async function closeConnection(conn: McpConnection): Promise<void> {
  try {
    await conn.client.close();
  } catch {
    /* ignore */
  }
  await closeMcpTransport(conn.transport);
}

export class McpManager {
  private connections = new Map<string, McpConnection>();

  /** Close one server connection and drop it from the active map. */
  async closeServer(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (!conn) return;
    this.connections.delete(serverName);
    await closeConnection(conn);
  }

  connectedServers(): string[] {
    return [...this.connections.keys()];
  }

  async connect(
    server: McpServerConfig,
    cwd: string,
    opts?: { agentHome?: string },
  ): Promise<McpToolBinding[]> {
    if (server.enabled === false) return [];

    const configErr = validateMcpServerConfig(server);
    if (configErr) throw new Error(configErr);

    await this.closeServer(server.name);

    const { transport } = createMcpClientTransport(server, {
      cwd,
      agentHome: opts?.agentHome,
    });
    const client = new Client({ name: 'minimal-agent-ts', version: '0.1.0' });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      this.connections.set(server.name, { client, transport });

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
          call: async (args, signal) => {
            if (signal?.aborted) return '[aborted]';
            const active = this.connections.get(server.name);
            if (!active) return `error: MCP server disconnected: ${server.name}`;
            try {
              const result = await active.client.callTool(
                { name: tool.name, arguments: args },
                CallToolResultSchema,
                { signal },
              );
              return formatToolResult(result);
            } catch (err) {
              if (
                (err instanceof DOMException && err.name === 'AbortError') ||
                (err instanceof Error && err.name === 'AbortError') ||
                signal?.aborted
              ) {
                return '[aborted]';
              }
              const msg = err instanceof Error ? err.message : String(err);
              return `error: MCP tool failed: ${msg}`;
            }
          },
        });
      }

      return bindings;
    } catch (err) {
      await closeMcpTransport(transport);
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    const conns = [...this.connections.values()];
    this.connections.clear();
    for (const conn of conns) {
      await closeConnection(conn);
    }
  }
}

export function filterMcpBindings(
  bindings: McpToolBinding[],
  policy: McpPolicy,
): McpToolBinding[] {
  return bindings.filter((b) => isToolAllowed(b.apiName, policy));
}