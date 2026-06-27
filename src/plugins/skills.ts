import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { SkillDefinition } from './types.js';

function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: raw.trim() };
  }

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    meta[key] = value;
  }

  return { meta, body: match[2].trim() };
}

function loadSkillFile(skillPath: string, folderName: string): SkillDefinition | null {
  try {
    const raw = readFileSync(skillPath, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    return {
      name: meta.name || folderName,
      description: meta.description || `Skill from ${folderName}`,
      path: skillPath,
      body,
    };
  } catch {
    return null;
  }
}

export function discoverSkills(dirs: string[]): Map<string, SkillDefinition> {
  const skills = new Map<string, SkillDefinition>();

  for (const root of dirs) {
    if (!existsSync(root)) continue;

    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(root, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;

      const skill = loadSkillFile(skillPath, entry.name);
      if (skill) skills.set(skill.name, skill);
    }

    // Also allow flat skills root/SKILL.md
    const flat = join(root, 'SKILL.md');
    if (existsSync(flat) && statSync(root).isDirectory()) {
      const folderName = root.split('/').pop() ?? 'skill';
      const skill = loadSkillFile(flat, folderName);
      if (skill) skills.set(skill.name, skill);
    }
  }

  return skills;
}

export function formatSkillForInvoke(skill: SkillDefinition, query?: string): string {
  const header = `# Skill: ${skill.name}\n${skill.description}\n\n`;
  const focus = query?.trim()
    ? `## Focus query\n${query.trim()}\n\n## Guidance\n`
    : '## Guidance\n';
  return `${header}${focus}${skill.body}`;
}

export function buildLoadedSkillsSystemBlock(skills: SkillDefinition[]): string {
  if (skills.length === 0) return '';
  const parts = skills.map(
    (s) => `### Skill: ${s.name}\n${s.description}\n\n${s.body.slice(0, 2000)}`,
  );
  return `\n\n## Loaded skills\n${parts.join('\n\n')}`;
}