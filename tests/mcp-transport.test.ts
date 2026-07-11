import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createMcpClientTransport,
  resolveMcpTransportKind,
  validateMcpServerConfig,
} from '../src/plugins/mcp-transport.js';

describe('mcp transport config', () => {
  it('defaults stdio when command is set', () => {
    assert.equal(
      resolveMcpTransportKind({
        name: 'fs',
        command: 'npx',
      }),
      'stdio',
    );
  });

  it('defaults streamable-http when url is set', () => {
    assert.equal(
      resolveMcpTransportKind({
        name: 'remote',
        url: 'http://127.0.0.1:8787/mcp',
      }),
      'streamable-http',
    );
  });

  it('rejects mixing command and url', () => {
    const err = validateMcpServerConfig({
      name: 'bad',
      command: 'npx',
      url: 'http://127.0.0.1:8787/mcp',
    });
    assert.match(err ?? '', /remove command or url/);
  });

  it('requires url for explicit sse transport', () => {
    const err = validateMcpServerConfig({
      name: 'legacy',
      transport: 'sse',
    });
    assert.match(err ?? '', /requires url/);
  });

  it('creates streamable-http transport', () => {
    const { kind, transport } = createMcpClientTransport(
      {
        name: 'remote',
        url: 'http://127.0.0.1:8787/mcp',
        headers: { Authorization: 'Bearer test' },
      },
      '/tmp',
    );
    assert.equal(kind, 'streamable-http');
    assert.equal(typeof transport.close, 'function');
  });

  it('creates sse transport when requested', () => {
    const { kind } = createMcpClientTransport(
      {
        name: 'legacy',
        transport: 'sse',
        url: 'http://127.0.0.1:9000/sse',
      },
      '/tmp',
    );
    assert.equal(kind, 'sse');
  });

  it('creates stdio transport', () => {
    const { kind } = createMcpClientTransport(
      {
        name: 'fs',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      },
      '/tmp',
    );
    assert.equal(kind, 'stdio');
  });
});