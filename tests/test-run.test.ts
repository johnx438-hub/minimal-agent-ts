import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatTestRunMarkdown,
  parseJestLikeOutput,
  parseJunitXml,
  parseNodeTestOutput,
  parseTapOutput,
  summarizeTestOutput,
} from '../src/tools/test-run.js';
import { BuiltinToolProvider } from '../src/tools/providers/builtin-provider.js';
import type { AgentConfig } from '../src/types.js';

describe('parseNodeTestOutput', () => {
  it('reads node:test footer counts and failure names', () => {
    const text = [
      '✖ does the thing (1.2ms)',
      '✖ another fail (0.1ms)',
      'ℹ tests 10',
      'ℹ pass 8',
      'ℹ fail 2',
      'ℹ skipped 0',
    ].join('\n');
    const p = parseNodeTestOutput(text);
    assert.ok(p);
    assert.equal(p!.format, 'node-test');
    assert.equal(p!.total, 10);
    assert.equal(p!.pass, 8);
    assert.equal(p!.fail, 2);
    assert.ok(p!.failures!.some((f) => f.includes('does the thing')));
  });
});

describe('parseTapOutput', () => {
  it('counts ok / not ok and footer', () => {
    const text = [
      'TAP version 13',
      'ok 1 - works',
      'not ok 2 - broken',
      '1..2',
      '# tests 2',
      '# pass 1',
      '# fail 1',
    ].join('\n');
    const p = parseTapOutput(text);
    assert.ok(p);
    assert.equal(p!.pass, 1);
    assert.equal(p!.fail, 1);
    assert.ok(p!.failures!.some((f) => f.includes('broken')));
  });
});

describe('parseJestLikeOutput', () => {
  it('parses Tests: summary line', () => {
    const text = 'Tests:       1 failed, 4 passed, 5 total\n';
    const p = parseJestLikeOutput(text);
    assert.ok(p);
    assert.equal(p!.fail, 1);
    assert.equal(p!.pass, 4);
    assert.equal(p!.total, 5);
  });
});

describe('parseJunitXml', () => {
  it('reads testsuites attributes and failed case names', () => {
    const xml = `
<testsuites tests="3" failures="1" errors="0" skipped="0">
  <testsuite name="s" tests="3" failures="1" errors="0" skipped="0">
    <testcase name="ok1" classname="c"/>
    <testcase name="bad" classname="c"><failure message="x">boom</failure></testcase>
  </testsuite>
</testsuites>`;
    const p = parseJunitXml(xml);
    assert.ok(p);
    assert.equal(p!.format, 'junit');
    assert.equal(p!.total, 3);
    assert.equal(p!.fail, 1);
    assert.ok(p!.failures!.includes('bad'));
  });
});

describe('summarizeTestOutput', () => {
  it('falls back to exit-only', () => {
    const s = summarizeTestOutput('random noise', 1);
    assert.equal(s.format, 'exit-only');
    assert.equal(s.fail, 1);
  });

  it('prefers node-test when present', () => {
    const s = summarizeTestOutput('ℹ tests 2\nℹ pass 2\nℹ fail 0\n', 0);
    assert.equal(s.format, 'node-test');
    assert.equal(s.pass, 2);
  });
});

describe('formatTestRunMarkdown', () => {
  it('renders PASS summary', () => {
    const md = formatTestRunMarkdown(
      {
        format: 'node-test',
        pass: 5,
        fail: 0,
        skip: 0,
        total: 5,
        failures: [],
        exitCode: 0,
        timedOut: false,
        aborted: false,
      },
      { command: 'npm test', maxFailures: 10, elapsedMs: 100 },
    );
    assert.match(md, /PASS/);
    assert.match(md, /pass=5/);
  });
});

describe('BuiltinToolProvider test_run', () => {
  it('requires shell capability', () => {
    const provider = new BuiltinToolProvider();
    provider.setEnabledForTests(['test_run', 'read_file']);
    const defsOff = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: {
        apiKey: 'k',
        baseUrl: 'u',
        model: 'm',
        maxTurns: 1,
        cwd: '/tmp',
        allowShell: false,
        allowWeb: false,
      } satisfies AgentConfig,
    });
    assert.deepEqual(defsOff.map((d) => d.function.name), ['read_file']);

    const defsOn = provider.getDefinitions({
      cwd: '/tmp',
      pluginConfig: {},
      config: {
        apiKey: 'k',
        baseUrl: 'u',
        model: 'm',
        maxTurns: 1,
        cwd: '/tmp',
        allowShell: true,
        allowWeb: false,
      } satisfies AgentConfig,
    });
    assert.ok(defsOn.some((d) => d.function.name === 'test_run'));
  });
});
