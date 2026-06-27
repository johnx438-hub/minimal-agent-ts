import type { AgentConfig, ToolDefinition } from '../types.js';
import type { SkillDefinition } from '../plugins/types.js';
import { formatSkillForInvoke } from '../plugins/skills.js';

export const SKILLS_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'invoke_skill',
      description:
        'Load guidance from a local SKILL.md. Omit name to list available skills; provide query to focus the returned guidance.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name (folder name). Omit to list available skills.',
          },
          query: {
            type: 'string',
            description: 'Optional focus question when loading a skill',
          },
        },
      },
    },
  },
];

export function runSkillsTool(
  name: string,
  args: Record<string, unknown>,
  skills: Map<string, SkillDefinition>,
): string | null {
  if (name !== 'invoke_skill') return null;

  const skillName = args.name !== undefined ? String(args.name).trim() : '';
  const query = args.query !== undefined ? String(args.query) : undefined;

  if (!skillName) {
    if (skills.size === 0) return 'No skills discovered. Add SKILL.md under ./skills or skills_dirs in agent.json.';
    const lines = [...skills.values()].map((s) => `- ${s.name}: ${s.description}`);
    return `Available skills:\n${lines.join('\n')}`;
  }

  const skill = skills.get(skillName);
  if (!skill) {
    const known = [...skills.keys()].join(', ') || '(none)';
    return `error: unknown skill "${skillName}". Known: ${known}`;
  }

  return formatSkillForInvoke(skill, query);
}