import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BuiltinToolProvider } from '../src/tools/providers/builtin-provider.js';
import type { AgentConfig } from '../src/types.js';

function baseConfig(cwd: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiKey: 'k',
    baseUrl: 'https://example.com',
    model: 'test',
    maxTurns: 5,
    cwd,
    allowShell: false,
    allowWeb: false,
    sessionId: 'sess',
    ...overrides,
  };
}

describe('BuiltinToolProvider', () => {
  it('exposes read/write defs when enabled', () => {
    const provider = new BuiltinToolProvider();
    provider.setEnabledForTests(['read_file', 'write_file']);

    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig('/tmp'),
    });
    assert.deepEqual(
      defs.map((d) => d.function.name).sort(),
      ['read_file', 'write_file'],
    );
  });

  it('omits run_shell when shell capability is off', () => {
    const provider = new BuiltinToolProvider();
    provider.setEnabledForTests(['run_shell', 'read_file']);

    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig('/tmp', { allowShell: false }),
    });
    assert.deepEqual(defs.map((d) => d.function.name), ['read_file']);
  });

  it('includes run_shell when shell capability is on', () => {
    const provider = new BuiltinToolProvider();
    provider.setEnabledForTests(['run_shell']);

    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig('/tmp', { allowShell: true }),
    });
    assert.equal(defs[0]!.function.name, 'run_shell');
  });

  it('omits web_fetch when web capability is off', () => {
    const provider = new BuiltinToolProvider();
    provider.setEnabledForTests(['web_fetch', 'grep_search']);

    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig('/tmp', { allowWeb: false }),
    });
    assert.deepEqual(defs.map((d) => d.function.name), ['grep_search']);
  });

  it('returns null for tools owned by other providers', async () => {
    const provider = new BuiltinToolProvider();
    provider.setEnabledForTests(['read_file']);

    const out = await provider.execute(
      'invoke_skill',
      {},
      { cwd: '/tmp', pluginConfig: {}, config: baseConfig('/tmp') },
    );
    assert.equal(out, null);
  });

  it('executes read_file on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'builtin-provider-read-'));
    const path = join(dir, 'hello.txt');
    writeFileSync(path, 'hello builtin provider', 'utf8');

    const provider = new BuiltinToolProvider();
    provider.setEnabledForTests(['read_file']);

    const out = await provider.execute(
      'read_file',
      { path: 'hello.txt' },
      { cwd: dir, pluginConfig: {}, config: baseConfig(dir) },
    );
    assert.ok(out);
    assert.match(out!, /hello builtin provider/);
  });

  it('executes write_file on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'builtin-provider-write-'));

    const provider = new BuiltinToolProvider();
    provider.setEnabledForTests(['write_file']);

    const out = await provider.execute(
      'write_file',
      { path: 'out.txt', content: 'written by provider' },
      { cwd: dir, pluginConfig: {}, config: baseConfig(dir) },
    );
    assert.match(out ?? '', /^ok: wrote/);
    assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'written by provider');
  });
});