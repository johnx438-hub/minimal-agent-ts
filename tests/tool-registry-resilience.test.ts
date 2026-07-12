import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgentConfig, ToolDefinition } from '../src/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolProvider, ToolResolveContext } from '../src/tools/providers/types.js';

class ThrowingProvider implements ToolProvider {
  async load(): Promise<void> {}

  async shutdown(): Promise<void> {}

  getDefinitions(_ctx: ToolResolveContext): ToolDefinition[] {
    throw new Error('mcp unavailable');
  }

  async execute(): Promise<string | null> {
    return null;
  }
}

describe('ToolRegistry getDefinitions resilience', () => {
  it('keeps other providers when one getDefinitions throws', async () => {
    const registry = new ToolRegistry() as ToolRegistry & {
      mcpProvider: ThrowingProvider;
    };
    registry.mcpProvider = new ThrowingProvider();

    const config: AgentConfig = {
      cwd: process.cwd(),
      model: 'deepseek/deepseek-chat',
      llm: { api_profile: '__env__' },
    };

    await registry.initialize(process.cwd(), {
      builtin_tools: ['read_file', 'write_file'],
      skills_dirs: [],
      spawn_presets: {},
    });

    const names = registry.getDefinitions(config).map((d) => d.function.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('write_file'));
  });
});