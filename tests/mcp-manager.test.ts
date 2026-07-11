import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpManager } from '../src/plugins/mcp-manager.js';

function fakeClient(): Client & { closed: boolean } {
  const client = {
    closed: false,
    async close() {
      client.closed = true;
    },
  };
  return client as Client & { closed: boolean };
}

function fakeTransport(): Transport & { closed: boolean } {
  const transport = {
    closed: false,
    async close() {
      transport.closed = true;
    },
  };
  return transport as Transport & { closed: boolean };
}

describe('McpManager', () => {
  it('closeServer removes and closes an active client', async () => {
    const mgr = new McpManager();
    const client = fakeClient();
    const transport = fakeTransport();
    (mgr as unknown as { connections: Map<string, { client: Client; transport: Transport }> })
      .connections.set('demo', { client, transport });

    await mgr.closeServer('demo');

    assert.equal(mgr.connectedServers().length, 0);
    assert.equal(client.closed, true);
    assert.equal(transport.closed, true);
  });

  it('closeServer is safe when server is not connected', async () => {
    const mgr = new McpManager();
    await mgr.closeServer('missing');
    assert.deepEqual(mgr.connectedServers(), []);
  });

  it('shutdown closes all clients and clears the map', async () => {
    const mgr = new McpManager();
    const a = fakeClient();
    const b = fakeClient();
    const ta = fakeTransport();
    const tb = fakeTransport();
    const map = (mgr as unknown as {
      connections: Map<string, { client: Client; transport: Transport }>;
    }).connections;
    map.set('a', { client: a, transport: ta });
    map.set('b', { client: b, transport: tb });

    await mgr.shutdown();

    assert.deepEqual(mgr.connectedServers(), []);
    assert.equal(a.closed, true);
    assert.equal(b.closed, true);
    assert.equal(ta.closed, true);
    assert.equal(tb.closed, true);
  });
});