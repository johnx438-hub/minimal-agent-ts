import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';

import {
  resetShellInvocationForTests,
  resolveShellInvocation,
} from '../src/tools/shell-resolve.js';
import { runShellCommand } from '../src/tools/shell.js';

const originalMinimalShell = process.env.MINIMAL_SHELL;
const originalShell = process.env.SHELL;

afterEach(() => {
  if (originalMinimalShell === undefined) delete process.env.MINIMAL_SHELL;
  else process.env.MINIMAL_SHELL = originalMinimalShell;
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  resetShellInvocationForTests();
});

describe('resolveShellInvocation', () => {
  it('prefers MINIMAL_SHELL when executable', () => {
    process.env.MINIMAL_SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    resetShellInvocationForTests();

    const shell = resolveShellInvocation();
    assert.equal(shell.source, 'minimal_shell');
    assert.equal(shell.command, process.env.MINIMAL_SHELL);
  });

  it('uses SHELL env on POSIX when MINIMAL_SHELL is unset', () => {
    if (process.platform === 'win32') return;

    delete process.env.MINIMAL_SHELL;
    process.env.SHELL = '/bin/sh';
    resetShellInvocationForTests();

    const shell = resolveShellInvocation();
    assert.equal(shell.command, '/bin/sh');
    assert.equal(shell.source, 'shell_env');
    assert.deepEqual(shell.buildArgs('echo hi'), ['-lc', 'echo hi']); // /bin/sh
  });

  it('falls back to a working shell on this platform', () => {
    delete process.env.MINIMAL_SHELL;
    if (process.platform !== 'win32') {
      delete process.env.SHELL;
    }
    resetShellInvocationForTests();

    const shell = resolveShellInvocation();
    assert.ok(shell.command);
    assert.ok(shell.buildArgs('exit 0').length >= 2);
  });
});

describe('runShellCommand', () => {
  it('executes a trivial command via resolved shell', async () => {
    resetShellInvocationForTests();
    const output = await runShellCommand({
      cwd: process.cwd(),
      command: process.platform === 'win32' ? 'echo hello-shell' : 'echo hello-shell',
      delayMs: 0,
      timeoutMs: 5_000,
      pollIntervalMs: 500,
      autoExtend: false,
      extendByMs: 30_000,
      maxTimeoutMs: 30_000,
    });

    assert.match(output, /hello-shell/);
  });
});