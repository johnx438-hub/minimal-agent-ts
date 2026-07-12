import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatRunStartLines,
  shortSessionId,
  shouldShowIoMetric,
} from '../src/tui/pi/run-header.js';
import {
  compressCommandCwd,
  truncateShellBody,
} from '../src/tui/pi/shell-display.js';
import { applyVerboseEnv, defaultPrefs } from '../src/tui/prefs.js';

describe('shortSessionId', () => {
  it('keeps short ids intact', () => {
    assert.equal(shortSessionId('session_abc'), 'session_abc');
  });

  it('ellipsizes long session ids', () => {
    const id = 'session_20260707144003_abcdefgh';
    const short = shortSessionId(id);
    assert.ok(short.startsWith('session_…'));
    assert.ok(short.length < id.length);
  });
});

describe('formatRunStartLines', () => {
  it('returns a single compact line by default', () => {
    const lines = formatRunStartLines({
      sessionId: 'session_20260707144003',
      cwd: '/tmp/proj',
      llm: { profile: 'deepseek-main', model: 'deepseek-v4-pro', cache_mode: 'off' },
      agentMd: { path: 'Agent.md', chars: 100, truncated: false },
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^▶ run · /);
    assert.match(lines[0]!, /deepseek/);
    assert.match(lines[0]!, /Agent\.md/);
  });

  it('expands details when verbose', () => {
    const lines = formatRunStartLines({
      sessionId: 'session_x',
      cwd: '/tmp/proj',
      llm: { profile: 'p', model: 'm', cache_mode: 'off' },
      verbose: true,
    });
    assert.ok(lines.length >= 2);
    assert.match(lines.join('\n'), /cwd: \/tmp\/proj/);
  });
});

describe('shouldShowIoMetric', () => {
  it('hides quiet flushes in compact mode', () => {
    assert.equal(shouldShowIoMetric({ verboseIo: false, pending: 0, flushMs: 1 }), false);
  });

  it('shows pending or slow flushes', () => {
    assert.equal(shouldShowIoMetric({ verboseIo: false, pending: 2, flushMs: 1 }), true);
    assert.equal(shouldShowIoMetric({ verboseIo: false, pending: 0, flushMs: 80 }), true);
  });

  it('shows all when verbose', () => {
    assert.equal(shouldShowIoMetric({ verboseIo: true, pending: 0, flushMs: 0 }), true);
  });
});

describe('compressCommandCwd', () => {
  it('strips cwd prefixes from commands', () => {
    const cwd = '/home/a/proj';
    assert.equal(
      compressCommandCwd(`cd ${cwd} && cat ${cwd}/src/a.ts`, cwd),
      'cd . && cat src/a.ts',
    );
  });
});

describe('truncateShellBody', () => {
  it('caps long bodies and reports truncated line count', () => {
    const body = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    const out = truncateShellBody(body, 10);
    assert.equal(out.truncatedLines, 40);
    assert.match(out.body, /\+40 lines/);
    assert.ok(out.body.split('\n').length <= 11);
  });
});

describe('applyVerboseEnv', () => {
  it('turns on all verbose flags when TUI_VERBOSE=1', () => {
    const prev = process.env.TUI_VERBOSE;
    process.env.TUI_VERBOSE = '1';
    try {
      const p = applyVerboseEnv(defaultPrefs());
      assert.equal(p.verbose_turns, true);
      assert.equal(p.verbose_io, true);
      assert.equal(p.verbose_run_header, true);
      assert.equal(p.verbose_tools, true);
    } finally {
      if (prev === undefined) delete process.env.TUI_VERBOSE;
      else process.env.TUI_VERBOSE = prev;
    }
  });
});
