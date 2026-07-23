import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isToolDenied,
  isToolPermitted,
} from '../src/tools/providers/tool-allowlist.js';
import { loadStrategy } from '../src/eval/load.js';
import { defaultProjectRoot } from '../src/eval/run.js';
import { resolveEvalRoot } from '../src/eval/load.js';
import type { AgentConfig, ToolDefinition } from '../src/types.js';

// Lightweight mirror of registry filter used at getDefinitions end.
function filterDenied(
  defs: ToolDefinition[],
  toolDeny?: string[],
): ToolDefinition[] {
  if (!toolDeny?.length) return defs;
  return defs.filter((d) => !isToolDenied(d.function.name, toolDeny));
}

describe('tool deny list', () => {
  it('isToolDenied matches exact names', () => {
    assert.equal(isToolDenied('context_focus', ['context_focus']), true);
    assert.equal(isToolDenied('read_file', ['context_focus']), false);
    assert.equal(isToolDenied('context_focus', undefined), false);
  });

  it('isToolPermitted combines deny and allowlist', () => {
    assert.equal(
      isToolPermitted('context_focus', undefined, ['context_focus']),
      false,
    );
    assert.equal(
      isToolPermitted('read_file', ['read_file'], ['context_focus']),
      true,
    );
    assert.equal(
      isToolPermitted('write_file', ['read_file'], undefined),
      false,
    );
  });

  it('filters definitions like registry getDefinitions', () => {
    const defs: ToolDefinition[] = [
      {
        type: 'function',
        function: { name: 'read_file', description: '', parameters: {} },
      },
      {
        type: 'function',
        function: { name: 'context_focus', description: '', parameters: {} },
      },
    ];
    const filtered = filterDenied(defs, ['context_focus']);
    assert.deepEqual(
      filtered.map((d) => d.function.name),
      ['read_file'],
    );
  });

  it('eager strategy declares tool_deny context_focus', () => {
    const strategy = loadStrategy(
      resolveEvalRoot(defaultProjectRoot()),
      'minimal_pointerize_eager',
    );
    assert.ok(strategy.tool_deny?.includes('context_focus'));
  });

  it('apply-style merge sets config.toolDeny', () => {
    const config = { toolDeny: undefined } as AgentConfig;
    const deny = ['context_focus'];
    config.toolDeny = [...new Set([...(config.toolDeny ?? []), ...deny])];
    assert.deepEqual(config.toolDeny, ['context_focus']);
  });
});
