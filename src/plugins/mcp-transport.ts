import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { createMcpOAuthProvider } from './mcp-oauth.js';
import type { McpServerConfig, McpTransportKind } from './types.js';

export interface ResolvedMcpTransport {
  kind: McpTransportKind;
  transport: Transport;
}

export interface CreateMcpTransportOptions {
  /** Used for relative oauth.token_store paths. */
  cwd: string;
  /** Default token cache under $AGENT_HOME/mcp-oauth/. */
  agentHome?: string;
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

  if (server.oauth) {
    if (kind === 'stdio') {
      return `MCP server "${server.name}": oauth is only supported for streamable-http / sse (not stdio)`;
    }
    if (server.oauth.type !== 'client_credentials') {
      return `MCP server "${server.name}": oauth.type must be "client_credentials" (got "${server.oauth.type}")`;
    }
    const hasId =
      Boolean(server.oauth.client_id?.trim()) ||
      Boolean(server.oauth.client_id_env?.trim());
    const hasSecret =
      Boolean(server.oauth.client_secret?.trim()) ||
      Boolean(server.oauth.client_secret_env?.trim());
    if (!hasId || !hasSecret) {
      return `MCP server "${server.name}": client_credentials requires client_id(+_env) and client_secret(+_env)`;
    }
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
  cwdOrOpts: string | CreateMcpTransportOptions,
  maybeAgentHome?: string,
): ResolvedMcpTransport {
  // Back-compat: createMcpClientTransport(server, cwd) | (server, { cwd, agentHome })
  const opts: CreateMcpTransportOptions =
    typeof cwdOrOpts === 'string'
      ? { cwd: cwdOrOpts, agentHome: maybeAgentHome }
      : cwdOrOpts;

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
        cwd: server.cwd ?? opts.cwd,
        stderr: 'pipe',
      }),
    };
  }

  const authProvider = createMcpOAuthProvider(server, {
    cwd: opts.cwd,
    agentHome: opts.agentHome,
  });

  const url = new URL(server.url!.trim());
  if (kind === 'sse') {
    return {
      kind,
      transport: new SSEClientTransport(url, {
        requestInit,
        ...(authProvider ? { authProvider } : {}),
      }),
    };
  }

  return {
    kind,
    transport: new StreamableHTTPClientTransport(url, {
      requestInit,
      ...(authProvider ? { authProvider } : {}),
    }),
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