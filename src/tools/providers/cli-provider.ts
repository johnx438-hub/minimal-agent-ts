import { isCapabilityEnabled } from '../../permission-gate.js';
import type { ToolDefinition } from '../../types.js';
import { runWebSearchTool, WEB_SEARCH_DEFINITIONS } from '../web-search.js';
import { isRoleToolAllowlisted } from './tool-allowlist.js';
import type { ToolProvider, ToolProviderContext, ToolResolveContext } from './types.js';

type CliToolRunner = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolResolveContext,
) => Promise<string | null>;

interface CliToolEntry {
  defs: ToolDefinition[];
  requiresWeb: boolean;
  run: CliToolRunner;
}

const CLI_TOOLS: Record<string, CliToolEntry> = {
  web_search: {
    defs: WEB_SEARCH_DEFINITIONS,
    requiresWeb: true,
    run: (toolName, args, ctx) => runWebSearchTool(toolName, args, ctx.config),
  },
};

export const CLI_TOOL_NAMES = Object.keys(CLI_TOOLS) as (keyof typeof CLI_TOOLS)[];

export class CliToolProvider implements ToolProvider {
  private enabledBuiltin = new Set<string>();

  async load(ctx: ToolProviderContext): Promise<void> {
    this.enabledBuiltin = new Set(
      ctx.enabledBuiltin ?? ctx.pluginConfig.builtin_tools ?? [],
    );
  }

  async shutdown(): Promise<void> {
    this.enabledBuiltin.clear();
  }

  getDefinitions(ctx: ToolResolveContext): ToolDefinition[] {
    const allowlist = ctx.config.toolAllowlist;
    const defs: ToolDefinition[] = [];

    for (const toolName of CLI_TOOL_NAMES) {
      if (!this.enabledBuiltin.has(toolName)) continue;
      if (!isRoleToolAllowlisted(toolName, allowlist)) continue;

      const entry = CLI_TOOLS[toolName];
      if (entry.requiresWeb && !isCapabilityEnabled(ctx.config, 'web')) continue;

      for (const def of entry.defs) {
        const name = def.function.name;
        if (!this.enabledBuiltin.has(name)) continue;
        if (!isRoleToolAllowlisted(name, allowlist)) continue;
        defs.push(def);
      }
    }

    return defs;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolResolveContext,
  ): Promise<string | null> {
    const entry = CLI_TOOLS[name];
    if (!entry || !this.enabledBuiltin.has(name)) return null;

    if (entry.requiresWeb && !isCapabilityEnabled(ctx.config, 'web')) {
      const gate = ctx.config.permissionGate;
      if (!gate || !(await gate.ensureWeb(ctx.config, name))) {
        if (ctx.config.abortSignal?.aborted) return '[aborted]';
        return `error: ${name} is disabled. Use /web on or approve when prompted.`;
      }
    }

    return entry.run(name, args, ctx);
  }

  /** Test hook: set enabled builtin tools without registry load. */
  setEnabledForTests(enabledBuiltin: Iterable<string>): void {
    this.enabledBuiltin = new Set(enabledBuiltin);
  }
}