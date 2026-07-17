import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runReadWriteTool } from '../src/tools/read-write.js';
import type { AgentConfig } from '../src/types.js';
import {
  buildVisionAttachUserMessage,
  collectVisionAttachesFromToolOutputs,
  formatVisionAttachToolResult,
  parseVisionAttachFromToolOutput,
  visionRefFromPath,
} from '../src/vision.js';
import { configureSessionStore, resetWorkspaceForTests } from '../src/workspace.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function baseConfig(dir: string, supportsVision: boolean): AgentConfig {
  return {
    apiKey: 'k',
    baseUrl: 'https://example.com',
    model: 'm',
    maxTurns: 0,
    cwd: dir,
    allowShell: false,
    allowWeb: false,
    llm: {
      profileName: supportsVision ? 'kimi-main' : 'deepseek-main',
      baseUrl: 'https://example.com',
      apiKey: 'k',
      model: 'm',
      wire: 'openai_chat',
      available: true,
      supportsVision,
    },
    llmPluginConfig: {
      vision: { enabled: true },
    },
  };
}

describe('read_file vision attach', () => {
  it('parses vision_attach marker', () => {
    const ref = visionRefFromPath('shot.png');
    const out = formatVisionAttachToolResult(ref, 'ok note');
    const parsed = parseVisionAttachFromToolOutput(out);
    assert.equal(parsed?.path, 'shot.png');
    assert.equal(parsed?.mime, 'image/png');
    assert.match(out, /ok note/);
  });

  it('collects unique refs from tool outputs', () => {
    const a = formatVisionAttachToolResult(visionRefFromPath('a.png'), 'a');
    const b = formatVisionAttachToolResult(visionRefFromPath('b.jpg'), 'b');
    const dup = formatVisionAttachToolResult(visionRefFromPath('a.png'), 'dup');
    const refs = collectVisionAttachesFromToolOutputs([a, 'plain', b, dup]);
    assert.equal(refs.length, 2);
    assert.equal(refs[0]!.path, 'a.png');
    assert.equal(refs[1]!.path, 'b.jpg');
  });

  it('buildVisionAttachUserMessage carries vision_refs', () => {
    const msg = buildVisionAttachUserMessage([visionRefFromPath('x.png')]);
    assert.equal(msg.role, 'user');
    assert.equal(msg.vision_refs?.length, 1);
    assert.match(String(msg.content), /x\.png/);
  });

  it('read_file on png attaches when supportsVision', async () => {
    resetWorkspaceForTests();
    const dir = mkdtempSync(join(tmpdir(), 'rf-vis-'));
    configureSessionStore({ mode: 'project_local', cwd: dir });
    writeFileSync(join(dir, 'ui.png'), TINY_PNG);

    const out = await runReadWriteTool(
      'read_file',
      { path: 'ui.png' },
      baseConfig(dir, true),
    );
    assert.ok(out);
    assert.match(out!, /\[vision_attach\]/);
    assert.match(out!, /ui\.png/);
    const ref = parseVisionAttachFromToolOutput(out!);
    assert.equal(ref?.path, 'ui.png');
  });

  it('read_file on png hints when profile lacks vision', async () => {
    resetWorkspaceForTests();
    const dir = mkdtempSync(join(tmpdir(), 'rf-vis-no-'));
    configureSessionStore({ mode: 'project_local', cwd: dir });
    writeFileSync(join(dir, 'ui.png'), TINY_PNG);

    const out = await runReadWriteTool(
      'read_file',
      { path: 'ui.png' },
      baseConfig(dir, false),
    );
    assert.ok(out);
    assert.match(out!, /supports_vision/);
    assert.match(out!, /kimi-main|profile/i);
    assert.equal(parseVisionAttachFromToolOutput(out!), null);
  });

  it('read_file still reads text files', async () => {
    resetWorkspaceForTests();
    const dir = mkdtempSync(join(tmpdir(), 'rf-txt-'));
    configureSessionStore({ mode: 'project_local', cwd: dir });
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');

    const out = await runReadWriteTool(
      'read_file',
      { path: 'a.ts' },
      baseConfig(dir, true),
    );
    assert.ok(out);
    assert.match(out!, /export const x/);
    assert.equal(parseVisionAttachFromToolOutput(out!), null);
  });
});
