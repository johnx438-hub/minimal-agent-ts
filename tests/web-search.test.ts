import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  formatDdgrResults,
  parseDdgrJson,
  resolveWebSearchPolicy,
  runWebSearchTool,
  setRunDdgrForTests,
} from '../src/tools/web-search.js';
import { buildSpillDocument } from '../src/tools/web-fetch-spill.js';
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
    webSearchPolicy: {
      allowed: true,
      budget: { max_external_per_task: 2, warn_after: 1 },
    },
    webSearchTaskState: { externalCount: 0 },
    ...overrides,
  };
}

describe('web_search', () => {
  let root: string;

  afterEach(() => {
    setRunDdgrForTests(null);
  });

  it('parses ddgr JSON output', () => {
    const raw = JSON.stringify([
      { title: 'Alpha', url: 'https://a.example', abstract: 'snippet a' },
      { title: 'Beta', url: 'https://b.example', snippet: 'snippet b' },
    ]);
    const parsed = parseDdgrJson(raw);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!.url, 'https://a.example');
    assert.equal(parsed[1]!.snippet, 'snippet b');
    assert.match(formatDdgrResults(parsed), /Alpha/);
  });

  it('returns cache hits without calling ddgr', async () => {
    root = mkdtempSync(join(tmpdir(), 'web-search-cache-'));
    setWorkspaceRoot(root);
    const spillDir = join(root, '.cache/web-fetch', 'sess');
    mkdirSync(spillDir, { recursive: true });
    const doc = buildSpillDocument({
      url: 'https://docs.example.com/guide',
      title: 'Example Guide',
      markdown: 'TypeScript agent patterns and minimal design notes.',
      via: 'http',
    });
    writeFileSync(join(spillDir, 'page.md'), doc, 'utf8');

    let ddgrCalled = false;
    setRunDdgrForTests(async () => {
      ddgrCalled = true;
      return { code: 0, stdout: '[]', stderr: '' };
    });

    const result = await runWebSearchTool(
      'web_search',
      { query: 'TypeScript agent' },
      baseConfig(root),
    );
    assert.ok(result);
    assert.match(result!, /\[source: cache\]/);
    assert.match(result!, /docs\.example\.com/);
    assert.equal(ddgrCalled, false);
  });

  it('calls ddgr when cache misses and respects budget', async () => {
    root = mkdtempSync(join(tmpdir(), 'web-search-ddgr-'));
    setWorkspaceRoot(root);

    setRunDdgrForTests(async () => ({
      code: 0,
      stdout: JSON.stringify([
        { title: 'Hit', url: 'https://hit.example', abstract: 'found' },
      ]),
      stderr: '',
    }));

    const config = baseConfig(root);
    const first = await runWebSearchTool('web_search', { query: 'first' }, config);
    assert.ok(first?.includes('[source: ddgr]'));
    assert.equal(config.webSearchTaskState!.externalCount, 1);

    const second = await runWebSearchTool('web_search', { query: 'second' }, config);
    assert.ok(second?.includes('[web_search: 2/2 external this task]'));

    const third = await runWebSearchTool('web_search', { query: 'third' }, config);
    assert.match(third ?? '', /budget exhausted/);
  });

  it('reports disabled when allowWeb is off', async () => {
    root = mkdtempSync(join(tmpdir(), 'web-search-off-'));
    const result = await runWebSearchTool(
      'web_search',
      { query: 'test' },
      baseConfig(root, { allowWeb: false }),
    );
    assert.match(result ?? '', /disabled/);
  });

  it('reports ddgr missing', async () => {
    root = mkdtempSync(join(tmpdir(), 'web-search-missing-'));
    setRunDdgrForTests(async () => ({
      code: 127,
      stdout: '',
      stderr: 'spawn ENOENT',
    }));

    const result = await runWebSearchTool(
      'web_search',
      { query: 'missing ddgr', skip_cache: true },
      baseConfig(root, {
        webSearchPolicy: {
          allowed: true,
          cache: { enabled: false },
        },
      }),
    );
    assert.match(result ?? '', /ddgr not found/);
  });

  it('resolveWebSearchPolicy applies defaults', () => {
    const policy = resolveWebSearchPolicy({});
    assert.equal(policy.maxResultsDefault, 5);
    assert.equal(policy.cacheEnabled, true);
    assert.equal(policy.maxExternalPerTask, 5);
  });
});