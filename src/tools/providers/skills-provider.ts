import {
  buildLoadedSkillsSystemBlock,
  discoverSkills,
} from '../../plugins/skills.js';
import type { SkillDefinition } from '../../plugins/types.js';
import type { ToolDefinition } from '../../types.js';
import { runSkillsTool, SKILLS_TOOL_DEFINITIONS } from '../skills-tool.js';
import { isRoleToolAllowlisted } from './tool-allowlist.js';
import type { ToolProvider, ToolProviderContext, ToolResolveContext } from './types.js';

export class SkillsToolProvider implements ToolProvider {
  private skills = new Map<string, SkillDefinition>();
  private enabledBuiltin = new Set<string>();

  async load(ctx: ToolProviderContext): Promise<void> {
    this.skills = discoverSkills(ctx.pluginConfig.skills_dirs ?? []);
    this.enabledBuiltin = new Set(
      ctx.enabledBuiltin ?? ctx.pluginConfig.builtin_tools ?? [],
    );
  }

  async shutdown(): Promise<void> {
    this.skills.clear();
    this.enabledBuiltin.clear();
  }

  listSkillNames(): string[] {
    return [...this.skills.keys()];
  }

  getSkillSystemExtension(loadedSkillNames: string[] | undefined): string {
    const loaded = loadedSkillNames ?? [];
    const selected = loaded
      .map((name) => this.skills.get(name))
      .filter((s): s is SkillDefinition => Boolean(s));
    return buildLoadedSkillsSystemBlock(selected);
  }

  getDefinitions(ctx: ToolResolveContext): ToolDefinition[] {
    if (!this.enabledBuiltin.has('invoke_skill')) return [];
    if (!isRoleToolAllowlisted('invoke_skill', ctx.config.toolAllowlist)) return [];
    return SKILLS_TOOL_DEFINITIONS;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolResolveContext,
  ): Promise<string | null> {
    if (name !== 'invoke_skill') return null;
    if (!this.enabledBuiltin.has('invoke_skill')) return null;
    return runSkillsTool(name, args, this.skills) ?? 'error: invoke_skill failed';
  }

  /** Test hook: inject skills without scanning skills_dirs. */
  setSkillsForTests(
    skills: Map<string, SkillDefinition>,
    enabledBuiltin: Iterable<string> = ['invoke_skill'],
  ): void {
    this.skills = skills;
    this.enabledBuiltin = new Set(enabledBuiltin);
  }
}