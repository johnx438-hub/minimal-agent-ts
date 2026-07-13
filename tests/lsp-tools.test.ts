import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runLspTool } from '../src/tools/lsp.js';
import {
  formatLspQueryMarkdown,
  isTypeScriptLikePath,
  runTypeScriptLspQuery,
} from '../src/tools/lsp-typescript.js';
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

function writeFixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'ma-lsp-'));
  writeFileSync(
    join(cwd, 'lib.ts'),
    [
      'export function greet(name: string): string {',
      '  return `hi ${name}`;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(cwd, 'main.ts'),
    [
      'import { greet } from "./lib.js";',
      '',
      'const msg = greet("world");',
      'console.log(msg);',
      '',
    ].join('\n'),
    'utf8',
  );
  return cwd;
}

describe('isTypeScriptLikePath', () => {
  it('accepts ts/js family', () => {
    assert.equal(isTypeScriptLikePath('a.ts'), true);
    assert.equal(isTypeScriptLikePath('a.tsx'), true);
    assert.equal(isTypeScriptLikePath('a.mjs'), true);
    assert.equal(isTypeScriptLikePath('a.py'), false);
  });
});

describe('runTypeScriptLspQuery', () => {
  it('resolves definition of greet import usage', () => {
    const cwd = writeFixture();
    // main.ts line 3: const msg = greet("world");
    // "greet" starts around character 12 (1-based)
    const result = runTypeScriptLspQuery({
      cwd,
      path: join(cwd, 'main.ts'),
      line: 3,
      character: 13,
      operation: 'definition',
    });
    assert.ok(!('error' in result), JSON.stringify(result));
    assert.equal(result.operation, 'definition');
    assert.ok(result.items.length >= 1, 'expected at least one definition');
    const hit = result.items.find((i) => i.path.includes('lib.ts') || i.path.endsWith('lib.ts'));
    assert.ok(hit, `definition should point at lib.ts, got ${JSON.stringify(result.items)}`);
  });

  it('returns hover text for greet', () => {
    const cwd = writeFixture();
    const result = runTypeScriptLspQuery({
      cwd,
      path: join(cwd, 'main.ts'),
      line: 3,
      character: 13,
      operation: 'hover',
    });
    assert.ok(!('error' in result));
    assert.ok(result.hover && result.hover.length > 0);
    assert.match(result.hover!, /greet|string/i);
  });

  it('lists document symbols for lib.ts', () => {
    const cwd = writeFixture();
    const result = runTypeScriptLspQuery({
      cwd,
      path: join(cwd, 'lib.ts'),
      line: 1,
      character: 1,
      operation: 'symbols',
    });
    assert.ok(!('error' in result));
    assert.ok(result.items.some((i) => (i.text ?? '').includes('greet')));
  });

  it('rejects unsupported extensions', () => {
    const cwd = writeFixture();
    writeFileSync(join(cwd, 'x.py'), 'x = 1\n', 'utf8');
    const result = runTypeScriptLspQuery({
      cwd,
      path: join(cwd, 'x.py'),
      line: 1,
      character: 1,
      operation: 'hover',
    });
    assert.ok('error' in result);
    assert.match(result.error, /no TypeScript|language service/i);
  });
});

describe('formatLspQueryMarkdown', () => {
  it('renders definition list', () => {
    const md = formatLspQueryMarkdown({
      operation: 'definition',
      path: 'main.ts',
      line: 3,
      character: 1,
      backend: 'typescript-api',
      items: [{ path: 'lib.ts', line: 1, character: 17, text: 'greet' }],
    });
    assert.match(md, /definition/);
    assert.match(md, /lib\.ts:1:17/);
  });
});

describe('runLspTool', () => {
  it('executes definition via tool handler', async () => {
    const cwd = writeFixture();
    const out = await runLspTool(
      'lsp_query',
      { path: 'main.ts', line: 3, character: 13, operation: 'definition' },
      baseConfig(cwd),
    );
    assert.ok(out);
    assert.ok(!out!.startsWith('error:'), out!);
    assert.match(out!, /lib\.ts/);
  });

  it('validates required fields', async () => {
    const cwd = writeFixture();
    const out = await runLspTool(
      'lsp_query',
      { path: 'main.ts', operation: 'hover' },
      baseConfig(cwd),
    );
    assert.match(out ?? '', /line must be/);
  });

  it('returns null for other tools', async () => {
    assert.equal(await runLspTool('read_file', {}, baseConfig('/tmp')), null);
  });
});

describe('BuiltinToolProvider lsp_query', () => {
  it('exposes lsp_query without shell', () => {
    const provider = new BuiltinToolProvider();
    provider.setEnabledForTests(['lsp_query', 'run_shell']);
    const defs = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: baseConfig('/tmp', { allowShell: false }),
    });
    assert.deepEqual(
      defs.map((d) => d.function.name),
      ['lsp_query'],
    );
  });
});
