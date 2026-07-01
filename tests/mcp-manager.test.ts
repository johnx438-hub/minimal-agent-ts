import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
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

describe('McpManager', () => {
  it('closeServer removes and closes an active client', async () => {
    const mgr = new McpManager();
    const client = fakeClient();
    (mgr as unknown as { clients: Map<string, Client> }).clients.set('demo', client);

    await mgr.closeServer('demo');

    assert.equal(mgr.connectedServers().length, 0);
    assert.equal(client.closed, true);
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
    const map = (mgr as unknown as { clients: Map<string, Client> }).clients;
    map.set('a', a);
    map.set('b', b);

    await mgr.shutdown();

    assert.deepEqual(mgr.connectedServers(), []);
    assert.equal(a.closed, true);
    assert.equal(b.closed, true);
  });
});