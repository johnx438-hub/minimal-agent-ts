import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runEditFileTool } from '../src/tools/edit-file.js';
import { runReadWriteTool } from '../src/tools/read-write.js';
import {
  buildMalformedToolCallNudge,
  decodeShellCommand,
  decodeWriteFileContent,
  isToolArgsJsonValid,
  parseToolArgsJson,
  partitionToolCallsByValidJson,
  resolveEditFileStringFields,
  resolveShellCommandFromArgsJson,
} from '../src/tools/tool-args.js';
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

  it('suggests b64 fields on edit_file JSON parse failure', () => {
    const result = parseToolArgsJson('{"path":"a.ts","old_string":"unclosed', 'edit_file');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /old_string_b64/);
  });

  it('suggests command_b64 on run_shell JSON parse failure', () => {
    const result = parseToolArgsJson('{"command":"echo "hi"', 'run_shell');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /command_b64/);
  });

  it('isToolArgsJsonValid rejects truncated JSON', () => {
    assert.equal(isToolArgsJsonValid('{"command":"broken'), false);
    assert.equal(isToolArgsJsonValid('{"command":"ok"}'), true);
  });

  it('partitions tool calls by JSON validity', () => {
    const calls = [
      {
        id: 'a',
        type: 'function' as const,
        function: { name: 'run_shell', arguments: '{"command":"ok"}' },
      },
      {
        id: 'b',
        type: 'function' as const,
        function: { name: 'run_shell', arguments: '{"command":"bad' },
      },
    ];
    const { valid, invalid } = partitionToolCallsByValidJson(calls);
    assert.equal(valid.length, 1);
    assert.equal(invalid.length, 1);
    assert.match(buildMalformedToolCallNudge(invalid), /command_b64/);
  });

  it('resolveShellCommandFromArgsJson mirrors decodeShellCommand', () => {
    const cmd = 'curl -s "https://example.com"';
    const b64 = Buffer.from(cmd, 'utf8').toString('base64');
    assert.equal(
      resolveShellCommandFromArgsJson(JSON.stringify({ command_b64: b64 })),
      cmd,
    );
    assert.equal(resolveShellCommandFromArgsJson('{"command":'), '');
  });

  it('decodes command_b64 for run_shell', () => {
    const cmd = 'opencli search "hello world"';
    const decoded = decodeShellCommand({
      command_b64: Buffer.from(cmd, 'utf8').toString('base64'),
    });
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;
    assert.equal(decoded.command, cmd);
    assert.equal(decoded.source, 'command_b64');
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

  it('resolves edit_file b64 fields with priority', () => {
    const snippet = '<div class="mask">"x"</div>';
    const b64 = Buffer.from(snippet, 'utf8').toString('base64');
    const resolved = resolveEditFileStringFields({
      path: 'a.html',
      old_string: 'wrong',
      old_string_b64: b64,
      new_string_b64: Buffer.from('replaced', 'utf8').toString('base64'),
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.fields.old_string, snippet);
    assert.equal(resolved.fields.new_string, 'replaced');
    assert.equal(resolved.fields.hasSearch, true);
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

  it('applies edit_file search_replace via old_string_b64', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edit-b64-'));
    const path = join(dir, 'game.html');
    writeFileSync(path, '<old>"quote"</old>', 'utf8');
    const oldB64 = Buffer.from('<old>"quote"</old>', 'utf8').toString('base64');
    const newB64 = Buffer.from('<new>"safe"</new>', 'utf8').toString('base64');
    const config: AgentConfig = {
      apiKey: 'k',
      baseUrl: 'http://localhost',
      model: 'm',
      maxTurns: 0,
      cwd: dir,
      allowShell: false,
      allowWeb: false,
    };

    const out = await runEditFileTool(
      'edit_file',
      { path: 'game.html', old_string_b64: oldB64, new_string_b64: newB64 },
      config,
    );
    assert.match(out ?? '', /^ok: edited/);
    assert.equal(readFileSync(path, 'utf8'), '<new>"safe"</new>');
  });
});