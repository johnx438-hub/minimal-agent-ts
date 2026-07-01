import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scheduleToolCalls } from '../src/tool-scheduler.js';
import type { ToolCall } from '../src/types.js';

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

describe('scheduleToolCalls', () => {
  it('parallelizes independent read-only tools', () => {
    const calls = [
      call('a', 'read_file', { path: 'a.ts' }),
      call('b', 'grep_search', { pattern: 'foo', path: 'src' }),
    ];
    const plan = scheduleToolCalls(calls);

    assert.equal(plan.parallel.length, 2);
    assert.equal(plan.serial.length, 0);
    assert.deepEqual(
      plan.entries.map((e) => e.reason),
      ['parallel_safe', 'parallel_safe'],
    );
    assert.deepEqual(
      plan.entries.map((e) => e.disposition),
      ['parallel', 'parallel'],
    );
  });

  it('keeps write tools serial with serial_only_tool', () => {
    const calls = [
      call('a', 'read_file', { path: 'a.ts' }),
      call('b', 'read_file', { path: 'b.ts' }),
      call('c', 'write_file', { path: 'out.ts', content: 'x' }),
    ];
    const plan = scheduleToolCalls(calls);

    assert.equal(plan.parallel.length, 2);
    assert.equal(plan.serial.length, 1);
    assert.equal(plan.entries[2]?.reason, 'serial_only_tool');
    assert.equal(plan.entries[2]?.disposition, 'serial');
  });

  it('demotes read when a pending write targets the same path', () => {
    const calls = [
      call('w', 'write_file', { path: 'src/foo.ts', content: 'x' }),
      call('r', 'read_file', { path: 'src/foo.ts' }),
    ];
    const plan = scheduleToolCalls(calls);

    assert.equal(plan.parallel.length, 0);
    assert.equal(plan.serial.length, 2);
    assert.equal(plan.entries[1]?.reason, 'conflicts_pending_write');
    assert.equal(plan.entries[1]?.detail, 'path=src/foo.ts');
  });

  it('demotes read when shell touches the same path', () => {
    const calls = [
      call('s', 'run_shell', { command: 'cat package.json' }),
      call('r', 'read_file', { path: 'package.json' }),
    ];
    const plan = scheduleToolCalls(calls);

    assert.equal(plan.parallel.length, 0);
    assert.equal(plan.entries[1]?.reason, 'conflicts_shell_on_path');
    assert.match(plan.entries[1]?.detail ?? '', /path=package\.json/);
  });

  it('marks unknown tools as not_parallel_safe', () => {
    const calls = [call('x', 'custom_tool', { foo: 1 }), call('y', 'read_file', { path: 'a.ts' })];
    const plan = scheduleToolCalls(calls);

    assert.equal(plan.entries[0]?.reason, 'not_parallel_safe');
    assert.equal(plan.entries[0]?.disposition, 'serial');
    assert.equal(plan.parallel.length, 1);
    assert.equal(plan.serial.length, 1);
  });

  it('preserves entry order matching LLM tool_calls order', () => {
    const calls = [
      call('1', 'read_file', { path: 'first.ts' }),
      call('2', 'write_file', { path: 'second.ts', content: '' }),
      call('3', 'grep_search', { pattern: 'x', path: '.' }),
    ];
    const plan = scheduleToolCalls(calls);

    assert.deepEqual(
      plan.entries.map((e) => e.id),
      ['1', '2', '3'],
    );
  });
});