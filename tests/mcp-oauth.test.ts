import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';

import {
  createMcpOAuthProvider,
  defaultMcpTokenStorePath,
  resolveClientCredentials,
  resolveMcpCredential,
  resolveMcpTokenStorePath,
  saveMcpTokensFile,
} from '../src/plugins/mcp-oauth.js';
import {
  createMcpClientTransport,
  validateMcpServerConfig,
} from '../src/plugins/mcp-transport.js';
import type { McpServerConfig } from '../src/plugins/types.js';

describe('mcp oauth client_credentials helpers', () => {
  it('resolves literal then env credentials', () => {
    assert.equal(resolveMcpCredential('  id  ', 'IGNORED'), 'id');
    const prev = process.env.MCP_TEST_SECRET;
    process.env.MCP_TEST_SECRET = 'from-env';
    try {
      assert.equal(resolveMcpCredential(undefined, 'MCP_TEST_SECRET'), 'from-env');
      assert.equal(resolveMcpCredential('', 'MCP_TEST_SECRET'), 'from-env');
    } finally {
      if (prev === undefined) delete process.env.MCP_TEST_SECRET;
      else process.env.MCP_TEST_SECRET = prev;
    }
  });

  it('resolveClientCredentials requires id and secret', () => {
    const bad = resolveClientCredentials({
      type: 'client_credentials',
      client_id: 'x',
    });
    assert.ok('error' in bad);

    const ok = resolveClientCredentials({
      type: 'client_credentials',
      client_id: 'x',
      client_secret: 'y',
    });
    assert.ok(!('error' in ok));
    if (!('error' in ok)) {
      assert.equal(ok.clientId, 'x');
      assert.equal(ok.clientSecret, 'y');
    }
  });

  it('default token path under agent home', () => {
    const p = defaultMcpTokenStorePath('My Server!', '/tmp/agent-home');
    assert.equal(p, join('/tmp/agent-home', 'mcp-oauth', 'My_Server.json'));
  });

  it('resolveMcpTokenStorePath: relative / absolute / default', () => {
    const server: McpServerConfig = { name: 'svc', url: 'http://127.0.0.1/mcp' };
    const oauth = {
      type: 'client_credentials' as const,
      client_id: 'a',
      client_secret: 'b',
      token_store: 'tokens/svc.json',
    };
    assert.equal(
      resolveMcpTokenStorePath(server, oauth, { cwd: '/proj' }),
      join('/proj', 'tokens', 'svc.json'),
    );
    assert.equal(
      resolveMcpTokenStorePath(
        server,
        { ...oauth, token_store: '/var/tok.json' },
        { cwd: '/proj' },
      ),
      '/var/tok.json',
    );
    assert.equal(
      resolveMcpTokenStorePath(
        server,
        { type: 'client_credentials', client_id: 'a', client_secret: 'b' },
        { cwd: '/proj', agentHome: '/home/x/.minimal-agent' },
      ),
      join('/home/x/.minimal-agent', 'mcp-oauth', 'svc.json'),
    );
  });

  it('validate rejects oauth on stdio and missing secrets', () => {
    assert.match(
      validateMcpServerConfig({
        name: 'x',
        command: 'npx',
        oauth: {
          type: 'client_credentials',
          client_id: 'a',
          client_secret: 'b',
        },
      }) ?? '',
      /oauth is only supported/,
    );
    assert.match(
      validateMcpServerConfig({
        name: 'x',
        url: 'http://127.0.0.1/mcp',
        oauth: { type: 'client_credentials', client_id: 'a' },
      }) ?? '',
      /client_secret/,
    );
  });

  it('validate accepts http + client_credentials env fields', () => {
    const err = validateMcpServerConfig({
      name: 'remote_oauth',
      url: 'https://mcp.example.com/mcp',
      oauth: {
        type: 'client_credentials',
        client_id_env: 'MCP_ID',
        client_secret_env: 'MCP_SECRET',
      },
    });
    assert.equal(err, null);
  });

  it('createMcpClientTransport attaches oauth provider for streamable-http', () => {
    const { kind, transport } = createMcpClientTransport(
      {
        name: 'remote_oauth',
        url: 'http://127.0.0.1:8787/mcp',
        oauth: {
          type: 'client_credentials',
          client_id: 'cid',
          client_secret: 'csecret',
        },
      },
      { cwd: '/tmp', agentHome: '/tmp/agent-home-test' },
    );
    assert.equal(kind, 'streamable-http');
    assert.equal(typeof transport.close, 'function');
  });

  it('createMcpOAuthProvider hydrates and persists tokens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-'));
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const store = join(dir, 'tok.json');
    saveMcpTokensFile(store, {
      access_token: 'cached-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    const provider = createMcpOAuthProvider(
      {
        name: 'svc',
        url: 'http://127.0.0.1/mcp',
        oauth: {
          type: 'client_credentials',
          client_id: 'cid',
          client_secret: 'sec',
          token_store: store,
        },
      },
      { cwd: dir },
    );
    assert.ok(provider);
    assert.equal(provider!.tokens()?.access_token, 'cached-token');

    provider!.saveTokens({
      access_token: 'new-token',
      token_type: 'Bearer',
      expires_in: 60,
    });
    const disk = JSON.parse(readFileSync(store, 'utf8')) as { access_token: string };
    assert.equal(disk.access_token, 'new-token');
  });
});
