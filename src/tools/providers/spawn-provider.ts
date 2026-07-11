import { loadSpawnPresets } from '../../spawn/load-preset.js';
import { configureSpawnSemaphore } from '../../spawn/semaphore.js';
import type { ResolvedSpawnPreset } from '../../spawn/types.js';
import type { ToolDefinition } from '../../types.js';
import { buildSpawnBackgroundDefinitions, runSpawnBackgroundTool } from '../spawn-background.js';
import { buildSpawnDefinitions, runSpawnTool } from '../spawn.js';
import { isRoleToolAllowlisted } from './tool-allowlist.js';
import type { ToolProvider, ToolProviderContext, ToolResolveContext } from './types.js';

const SPAWN_TOOL_NAMES = ['spawn_agent', 'spawn_background'] as const;
type SpawnToolName = (typeof SPAWN_TOOL_NAMES)[number];

export class SpawnToolProvider implements ToolProvider {
  private presets: ResolvedSpawnPreset[] = [];
  private enabledBuiltin = new Set<string>();

  async load(ctx: ToolProviderContext): Promise<void> {
    this.presets = loadSpawnPresets(
      ctx.cwd,
      ctx.pluginConfig.spawn_presets,
      ctx.pluginConfig.spawn_policy,
    );
    configureSpawnSemaphore(ctx.pluginConfig.spawn_policy?.max_parallel ?? 1);
    this.enabledBuiltin = new Set(
      ctx.enabledBuiltin ?? ctx.pluginConfig.builtin_tools ?? [],
    );
  }

  async shutdown(): Promise<void> {
    this.presets = [];
    this.enabledBuiltin.clear();
  }

  hasSpawnPresets(): boolean {
    return this.presets.length > 0;
  }

  listSpawnPresetNames(): string[] {
    return this.presets.map((p) => p.name);
  }

  getSpawnPresets(): ResolvedSpawnPreset[] {
    return this.presets;
  }

  getDefinitions(ctx: ToolResolveContext): ToolDefinition[] {
    if (this.presets.length === 0) return [];
    if ((ctx.config.spawnDepth ?? 0) > 0) return [];

    const allowlist = ctx.config.toolAllowlist;
    const defs: ToolDefinition[] = [];

    if (
      this.enabledBuiltin.has('spawn_agent') &&
      isRoleToolAllowlisted('spawn_agent', allowlist)
    ) {
      defs.push(...buildSpawnDefinitions(this.presets));
    }
    if (
      this.enabledBuiltin.has('spawn_background') &&
      isRoleToolAllowlisted('spawn_background', allowlist)
    ) {
      defs.push(...buildSpawnBackgroundDefinitions(this.presets));
    }

    return defs;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolResolveContext,
  ): Promise<string | null> {
    if (!this.isSpawnToolName(name)) return null;

    if (!this.enabledBuiltin.has(name) || this.presets.length === 0) {
      return `error: ${name} is not configured (add spawn_presets and ${name} to agent.json)`;
    }

    if (name === 'spawn_agent') {
      return runSpawnTool(name, args, ctx.config, this.presets);
    }
    return runSpawnBackgroundTool(name, args, ctx.config, this.presets);
  }

  /** Test hook: inject presets without loading from disk. */
  setPresetsForTests(
    presets: ResolvedSpawnPreset[],
    enabledBuiltin: Iterable<string> = SPAWN_TOOL_NAMES,
  ): void {
    this.presets = presets;
    this.enabledBuiltin = new Set(enabledBuiltin);
  }

  private isSpawnToolName(name: string): name is SpawnToolName {
    return (SPAWN_TOOL_NAMES as readonly string[]).includes(name);
  }
}