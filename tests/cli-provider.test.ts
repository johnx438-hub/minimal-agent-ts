import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { CliToolProvider } from '../src/tools/providers/cli-provider.js';
import { buildSpillDocument } from '../src/tools/web-fetch-spill.js';
import { setRunDdgrForTests } from '../src/tools/web-search.js';
import type { AgentConfig } from '../src/types.js';
import { setWorkspaceRoot } from '../src/workspace.js';

function baseConfig(cwd: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiKey: 'k',
    baseUrl: 'https://example.com',
    model: 'test',
    maxTurns: 5,
    cwd,
    allowShell: false,
    allowWeb: true,
    webSearchPolicy: { allowed: true },
    webSearchTaskState: { externalCount: 0 },
    ...overrides,
  };
}

describe('CliToolProvider', () => {
  let root: string;

  afterEach(() => {
    setRunDdgrForTests(null);
  });

  it('exposes web_search def when enabled and web is on', () => {
    const provider = new CliToolProvider();
    provider.setEnabledForTests(['web_search']);

    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig('/tmp'),
    });
    assert.equal(defs.length, 1);
    assert.equal(defs[0]!.function.name, 'web_search');
  });

  it('omits web_search def when web capability is off', () => {
    const provider = new CliToolProvider();
    provider.setEnabledForTests(['web_search']);

    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig('/tmp', { allowWeb: false }),
    });
    assert.deepEqual(defs, []);
  });

  it('omits web_search def when builtin tool is disabled', () => {
    const provider = new CliToolProvider();
    provider.setEnabledForTests(['read_file']);

    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig('/tmp'),
    });
    assert.deepEqual(defs, []);
  });

  it('returns null for non-cli tools', async () => {
    const provider = new CliToolProvider();
    provider.setEnabledForTests(['web_search']);

    const out = await provider.execute(
      'read_file',
      { path: 'a.ts' },
      { cwd: '/tmp', pluginConfig: {}, config: baseConfig('/tmp') },
    );
    assert.equal(out, null);
  });

  it('executes web_search through cli backend', async () => {
    root = mkdtempSync(join(tmpdir(), 'cli-provider-search-'));
    setWorkspaceRoot(root);

    setRunDdgrForTests(async () => ({
      code: 0,
      stdout: JSON.stringify([
        { title: 'CLI Provider', url: 'https://example.com', abstract: 'works' },
      ]),
      stderr: '',
    }));

    const provider = new CliToolProvider();
    provider.setEnabledForTests(['web_search']);

    const out = await provider.execute(
      'web_search',
      { query: 'cli provider test', skip_cache: true },
      { cwd: root, pluginConfig: {}, config: baseConfig(root) },
    );
    assert.ok(out);
    assert.match(out!, /CLI Provider/);
    assert.match(out!, /https:\/\/example\.com/);
  });

  it('uses spill cache before external cli search', async () => {
    root = mkdtempSync(join(tmpdir(), 'cli-provider-cache-'));
    setWorkspaceRoot(root);
    const spillDir = join(root, '.cache/web-fetch', 'sess');
    mkdirSync(spillDir, { recursive: true });
    writeFileSync(
      join(spillDir, 'page.md'),
      buildSpillDocument({
        url: 'https://docs.example.com/cli',
        title: 'CLI cache hit',
        markdown: 'Cached cli provider guidance.',
        via: 'http',
      }),
      'utf8',
    );

    let ddgrCalled = false;
    setRunDdgrForTests(async () => {
      ddgrCalled = true;
      return { code: 0, stdout: '[]', stderr: '' };
    });

    const provider = new CliToolProvider();
    provider.setEnabledForTests(['web_search']);

    const out = await provider.execute(
      'web_search',
      { query: 'cli provider cache' },
      { cwd: root, pluginConfig: {}, config: baseConfig(root) },
    );
    assert.ok(out);
    assert.match(out!, /\[source: cache\]/);
    assert.equal(ddgrCalled, false);
  });
});