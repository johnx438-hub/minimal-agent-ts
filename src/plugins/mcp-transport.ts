import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { McpServerConfig, McpTransportKind } from './types.js';

export interface ResolvedMcpTransport {
  kind: McpTransportKind;
  transport: Transport;
}

function buildRequestInit(headers?: Record<string, string>): RequestInit | undefined {
  if (!headers || Object.keys(headers).length === 0) return undefined;
  return { headers: new Headers(headers) };
}

/** Infer or validate transport kind from agent.json entry. */
export function resolveMcpTransportKind(server: McpServerConfig): McpTransportKind | null {
  if (server.transport) return server.transport;
  if (server.url?.trim()) return 'streamable-http';
  if (server.command?.trim()) return 'stdio';
  return null;
}

/** Returns a human-readable config error, or null when valid. */
export function validateMcpServerConfig(server: McpServerConfig): string | null {
  const hasCommand = Boolean(server.command?.trim());
  const hasUrl = Boolean(server.url?.trim());

  if (hasCommand && hasUrl) {
    return `MCP server "${server.name}": remove command or url (stdio uses command, http uses url)`;
  }

  const kind = resolveMcpTransportKind(server);
  if (!kind) {
    return `MCP server "${server.name}": set transport or provide command (stdio) / url (http)`;
  }

  if (kind === 'stdio') {
    if (!hasCommand) {
      return `MCP server "${server.name}": stdio transport requires command`;
    }
    return null;
  }

  const url = server.url?.trim();
  if (!url) {
    return `MCP server "${server.name}": ${kind} transport requires url`;
  }

  try {
    new URL(url);
  } catch {
    return `MCP server "${server.name}": invalid url "${url}"`;
  }

  return null;
}

export function createMcpClientTransport(
  server: McpServerConfig,
  cwd: string,
): ResolvedMcpTransport {
  const err = validateMcpServerConfig(server);
  if (err) throw new Error(err);

  const kind = resolveMcpTransportKind(server)!;
  const requestInit = buildRequestInit(server.headers);

  if (kind === 'stdio') {
    return {
      kind,
      transport: new StdioClientTransport({
        command: server.command!,
        args: server.args ?? [],
        env: server.env,
        cwd: server.cwd ?? cwd,
        stderr: 'pipe',
      }),
    };
  }

  const url = new URL(server.url!.trim());
  if (kind === 'sse') {
    return {
      kind,
      transport: new SSEClientTransport(url, { requestInit }),
    };
  }

  return {
    kind,
    transport: new StreamableHTTPClientTransport(url, { requestInit }),
  };
}

/** Best-effort HTTP session teardown before Client.close(). */
export async function terminateMcpHttpSession(transport: Transport): Promise<void> {
  if (
    'terminateSession' in transport &&
    typeof transport.terminateSession === 'function'
  ) {
    await transport.terminateSession().catch(() => undefined);
  }
}

/** Close a transport that never completed Client.connect (connect failure path). */
export async function closeMcpTransport(transport: Transport): Promise<void> {
  await terminateMcpHttpSession(transport);
  if (typeof transport.close === 'function') {
    await transport.close().catch(() => undefined);
  }
}