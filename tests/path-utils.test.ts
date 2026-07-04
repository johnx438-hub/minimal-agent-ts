import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PermissionGate } from '../src/permission-gate.js';
import {
  cwdChangeNeedsConfirm,
  pathWouldEscape,
  resolveReadablePath,
  resolveSafePath,
  resolveWritablePath,
} from '../src/tools/path-utils.js';
import type { AgentConfig } from '../src/types.js';

function testConfig(gate?: PermissionGate): AgentConfig {
  return {
    apiKey: 'test',
    baseUrl: 'http://localhost',
    model: 'test-model',
    cwd: '/home/project',
    allowShell: false,
    allowWeb: false,
    permissionGate: gate,
  };
}

describe('path utils', () => {
  it('detects paths outside cwd', () => {
    assert.equal(pathWouldEscape('/home/project', 'src/agent.ts'), false);
    assert.equal(pathWouldEscape('/home/project', '/etc/passwd'), true);
    assert.equal(pathWouldEscape('/home/project', '../other'), true);
  });

  it('resolveSafePath allows paths under cwd', () => {
    assert.equal(resolveSafePath('/home/project', 'src/x.ts'), '/home/project/src/x.ts');
  });

  it('resolveWritablePath rejects escape without prompting', () => {
    assert.throws(
      () => resolveWritablePath('/home/project', '/etc/passwd'),
      /path escapes working directory/,
    );
  });

  it('resolveReadablePath prompts via PermissionGate for escapes', async () => {
    const gate = new PermissionGate();
    let prompted = false;
    gate.setPrompter(async () => {
      prompted = true;
      return 'once';
    });

    const file = await resolveReadablePath(
      testConfig(gate),
      '/etc/passwd',
      'read_file: /etc/passwd',
    );
    assert.equal(prompted, true);
    assert.equal(file, '/etc/passwd');
  });

  it('resolveReadablePath rejects escape when gate denies', async () => {
    const gate = new PermissionGate();
    gate.setPrompter(async () => 'deny');

    await assert.rejects(
      () => resolveReadablePath(testConfig(gate), '/etc/passwd', 'read_file: /etc/passwd'),
      /path escapes working directory/,
    );
  });

  it('resolveReadablePath rejects escape without prompter', async () => {
    await assert.rejects(
      () => resolveReadablePath(testConfig(), '/etc/passwd', 'read_file: /etc/passwd'),
      /path escapes working directory/,
    );
  });

  it('cwdChangeNeedsConfirm flags moves outside current tree', () => {
    assert.equal(cwdChangeNeedsConfirm('/home/project', '/home/project/src'), false);
    assert.equal(cwdChangeNeedsConfirm('/home/project', '/home/other'), true);
    assert.equal(cwdChangeNeedsConfirm('/home/project', '/home/project'), false);
  });
});