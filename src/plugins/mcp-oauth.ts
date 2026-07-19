/**
 * MCP OAuth helpers — client_credentials (machine-to-machine) only for now.
 * Uses @modelcontextprotocol/sdk ClientCredentialsProvider + optional token file.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

import { ClientCredentialsProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

import { defaultAgentHome } from '../workspace.js';
import type { McpOAuthClientCredentials, McpServerConfig } from './types.js';

export interface McpOAuthResolveOptions {
  /** Project cwd (relative token_store paths). */
  cwd: string;
  /** Override agent home for default token path. */
  agentHome?: string;
}

function sanitizeServerFileName(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'mcp-server';
}

/** Resolve literal or env-backed credential. Prefer non-empty literal, else env. */
export function resolveMcpCredential(
  literal: string | undefined,
  envName: string | undefined,
): string | undefined {
  const lit = literal?.trim();
  if (lit) return lit;
  const key = envName?.trim();
  if (!key) return undefined;
  const v = process.env[key]?.trim();
  return v || undefined;
}

export function resolveClientCredentials(
  oauth: McpOAuthClientCredentials,
): { clientId: string; clientSecret: string } | { error: string } {
  if (oauth.type !== 'client_credentials') {
    return {
      error: `unsupported oauth.type "${String((oauth as { type?: string }).type)}"`,
    };
  }
  const clientId = resolveMcpCredential(oauth.client_id, oauth.client_id_env);
  const clientSecret = resolveMcpCredential(
    oauth.client_secret,
    oauth.client_secret_env,
  );
  if (!clientId) {
    return {
      error:
        'oauth client_credentials requires client_id or client_id_env (with a non-empty env value)',
    };
  }
  if (!clientSecret) {
    return {
      error:
        'oauth client_credentials requires client_secret or client_secret_env (with a non-empty env value)',
    };
  }
  return { clientId, clientSecret };
}

export function defaultMcpTokenStorePath(
  serverName: string,
  agentHome?: string,
): string {
  const home = agentHome?.trim() ? resolve(agentHome) : defaultAgentHome();
  return resolve(home, 'mcp-oauth', `${sanitizeServerFileName(serverName)}.json`);
}

export function resolveMcpTokenStorePath(
  server: McpServerConfig,
  oauth: McpOAuthClientCredentials,
  opts: McpOAuthResolveOptions,
): string {
  const raw = oauth.token_store?.trim();
  if (!raw) {
    return defaultMcpTokenStorePath(server.name, opts.agentHome);
  }
  if (raw.startsWith('~/')) {
    return resolve(homedir(), raw.slice(2));
  }
  if (isAbsolute(raw)) return resolve(raw);
  return resolve(opts.cwd, raw);
}

function loadTokensFile(path: string): OAuthTokens | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return undefined;
    const o = raw as Record<string, unknown>;
    if (typeof o.access_token !== 'string' || !o.access_token) return undefined;
    return {
      access_token: o.access_token,
      token_type: typeof o.token_type === 'string' ? o.token_type : 'Bearer',
      ...(typeof o.expires_in === 'number' ? { expires_in: o.expires_in } : {}),
      ...(typeof o.refresh_token === 'string'
        ? { refresh_token: o.refresh_token }
        : {}),
      ...(typeof o.scope === 'string' ? { scope: o.scope } : {}),
    };
  } catch {
    return undefined;
  }
}

export function saveMcpTokensFile(path: string, tokens: OAuthTokens): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

/**
 * Build OAuthClientProvider for a server, or null when oauth is not configured.
 * Throws if oauth is set but invalid.
 */
export function createMcpOAuthProvider(
  server: McpServerConfig,
  opts: McpOAuthResolveOptions,
): OAuthClientProvider | null {
  const oauth = server.oauth;
  if (!oauth) return null;

  if (oauth.type !== 'client_credentials') {
    throw new Error(
      `MCP server "${server.name}": oauth.type "${oauth.type}" is not supported (only client_credentials)`,
    );
  }

  const creds = resolveClientCredentials(oauth);
  if ('error' in creds) {
    throw new Error(`MCP server "${server.name}": ${creds.error}`);
  }

  const storePath = resolveMcpTokenStorePath(server, oauth, opts);
  const base = new ClientCredentialsProvider({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    clientName: oauth.client_name?.trim() || `minimal-agent:${server.name}`,
    scope: oauth.scope?.trim() || undefined,
  });

  const cached = loadTokensFile(storePath);
  if (cached) {
    base.saveTokens(cached);
  }

  // Persist tokens whenever the SDK saves them (after token endpoint success).
  return {
    get redirectUrl() {
      return base.redirectUrl;
    },
    get clientMetadata() {
      return base.clientMetadata;
    },
    clientInformation: () => base.clientInformation(),
    saveClientInformation: (info) => base.saveClientInformation(info),
    tokens: () => base.tokens(),
    saveTokens: (tokens) => {
      base.saveTokens(tokens);
      try {
        saveMcpTokensFile(storePath, tokens);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp] failed to persist tokens for ${server.name}: ${msg}`);
      }
    },
    redirectToAuthorization: () => base.redirectToAuthorization(),
    saveCodeVerifier: () => base.saveCodeVerifier(),
    codeVerifier: () => base.codeVerifier(),
    prepareTokenRequest: (scope?: string) => base.prepareTokenRequest(scope),
  };
}
