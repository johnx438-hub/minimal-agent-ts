import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runReadWriteTool } from '../src/tools/read-write.js';
import { decodeWriteFileContent, parseToolArgsJson } from '../src/tools/tool-args.js';
import { ensureToolRegistry, toolRegistry } from '../src/tools/registry.js';
import type { AgentConfig } from '../src/types.js';

describe('tool args parsing', () => {
  it('suggests content_b64 on write_file JSON parse failure', () => {
    const bad = '{"path":"a.html","content":"<div class="x">"}';
    const result = parseToolArgsJson(bad, 'write_file');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /invalid JSON arguments for write_file/);
    assert.match(result.error, /content_b64/);
    assert.match(result.error, /Preview:/);
    assert.ok(result.error.length < 500);
  });

  it('omits write_file hint for other tools', () => {
    const result = parseToolArgsJson('{bad', 'read_file');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.doesNotMatch(result.error, /content_b64/);
  });

  it('decodes content_b64 with priority over content', () => {
    const html = '<p>"quoted"</p>';
    const b64 = Buffer.from(html, 'utf8').toString('base64');
    const decoded = decodeWriteFileContent({
      path: 'a.html',
      content: 'wrong',
      content_b64: b64,
    });
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;
    assert.equal(decoded.content, html);
    assert.equal(decoded.source, 'content_b64');
  });

  it('rejects invalid base64', () => {
    const decoded = decodeWriteFileContent({ path: 'a.txt', content_b64: 'not!!!base64' });
    assert.equal(decoded.ok, false);
  });

  it('requires content or content_b64', () => {
    const decoded = decodeWriteFileContent({ path: 'a.txt' });
    assert.equal(decoded.ok, false);
    if (decoded.ok) return;
    assert.match(decoded.error, /content or content_b64/);
  });
});

describe('write_file content_b64 integration', () => {
  it('writes decoded bytes via runReadWriteTool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-b64-'));
    const html = '<!DOCTYPE html><style>.mask{content:"\\"x\\""}</style>';
    const b64 = Buffer.from(html, 'utf8').toString('base64');
    const config: AgentConfig = {
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      maxTurns: 0,
      cwd: dir,
      allowShell: false,
      allowWeb: false,
    };

    const out = await runReadWriteTool('write_file', { path: 'game.html', content_b64: b64 }, config);
    assert.match(out ?? '', /^ok: wrote/);
    const written = readFileSync(join(dir, 'game.html'), 'utf8');
    assert.equal(written, html);
  });

  it('registry executeTool surfaces write_file JSON hint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-b64-'));
    await ensureToolRegistry(dir, { builtin_tools: ['write_file'], skills_dirs: [] });
    const config: AgentConfig = {
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      maxTurns: 0,
      cwd: dir,
      allowShell: false,
      allowWeb: false,
    };
    const out = await toolRegistry.executeTool(
      'write_file',
      '{"path":"x.html","content":"<broken"',
      config,
    );
    assert.match(out, /content_b64/);
  });
});