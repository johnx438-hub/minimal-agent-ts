import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { McpToolBinding } from '../src/plugins/types.js';
import { McpToolProvider } from '../src/tools/providers/mcp-provider.js';
import { isRoleToolAllowlisted } from '../src/tools/providers/tool-allowlist.js';
import type { AgentConfig } from '../src/types.js';

function sampleBinding(apiName: string): McpToolBinding {
  return {
    apiName,
    serverName: 'demo',
    toolName: 'search',
    description: 'Search the web',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    call: async (args) => `ok:${String(args.q ?? '')}`,
  };
}

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiKey: 'k',
    baseUrl: 'https://example.com',
    model: 'test',
    maxTurns: 5,
    cwd: '/tmp',
    allowShell: false,
    allowWeb: false,
    sessionId: 'sess',
    ...overrides,
  };
}

describe('tool allowlist', () => {
  it('allows mcp_* wildcard', () => {
    assert.equal(isRoleToolAllowlisted('mcp_demo_tool', ['mcp_*']), true);
    assert.equal(isRoleToolAllowlisted('read_file', ['mcp_*']), false);
  });

  it('matches prefix wildcards', () => {
    assert.equal(isRoleToolAllowlisted('grep_search', ['grep*']), true);
    assert.equal(isRoleToolAllowlisted('read_file', ['grep*']), false);
  });
});

describe('McpToolProvider', () => {
  it('exposes MCP defs and respects role allowlist', () => {
    const provider = new McpToolProvider();
    provider.setBindingsForTests([
      sampleBinding('mcp_demo_search'),
      sampleBinding('mcp_demo_fetch'),
    ]);

    const ctx = {
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig({ toolAllowlist: ['mcp_*'] }),
    };

    const defs = provider.getDefinitions(ctx);
    assert.equal(defs.length, 2);
    assert.match(defs[0]!.function.description, /\[MCP:demo\]/);

    const filtered = provider.getDefinitions({
      ...ctx,
      config: baseConfig({ toolAllowlist: ['mcp_demo_search'] }),
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.function.name, 'mcp_demo_search');
  });

  it('executes owned tools and returns null for others', async () => {
    const provider = new McpToolProvider();
    provider.setBindingsForTests([sampleBinding('mcp_demo_search')]);

    const ctx = {
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig(),
    };

    const out = await provider.execute('mcp_demo_search', { q: 'ts' }, ctx);
    assert.equal(out, 'ok:ts');

    const miss = await provider.execute('read_file', { path: 'a.ts' }, ctx);
    assert.equal(miss, null);
  });

  it('lists MCP tools for TUI /mcp', () => {
    const provider = new McpToolProvider();
    provider.setBindingsForTests([sampleBinding('mcp_demo_search')]);

    const listed = provider.listMcpTools();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.apiName, 'mcp_demo_search');
    assert.equal(listed[0]!.serverName, 'demo');
  });
});