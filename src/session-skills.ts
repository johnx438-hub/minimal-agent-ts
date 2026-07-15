/**
 * Track mid-session invoke_skill loads on SessionFile for compression notices.
 * Distinct from agent.json loaded_skills (system injection).
 */

import type { SessionFile, SessionSkillInvoked } from './types.js';

const MAX_SKILLS_INVOKED = 32;

export function parseInvokeSkillArgs(argsJson: string): {
  name: string;
  query?: string;
} {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const query =
      typeof args.query === 'string' && args.query.trim()
        ? args.query.trim()
        : undefined;
    return { name, query };
  } catch {
    return { name: '' };
  }
}

/** True when invoke_skill returned a real skill body (not list / error). */
export function isSuccessfulSkillInvokeOutput(output: string): boolean {
  const t = output.trim();
  if (!t) return false;
  if (t.startsWith('error:')) return false;
  if (t.startsWith('Available skills:')) return false;
  if (t.startsWith('No skills discovered')) return false;
  return t.startsWith('# Skill:') || t.includes('# Skill:');
}

/**
 * Upsert skills_invoked entry. No-op if skillName empty.
 * Keeps at most MAX_SKILLS_INVOKED (drops oldest by `at` when over cap).
 */
export function recordSessionSkillInvoked(
  session: SessionFile,
  entry: {
    name: string;
    action_id?: string;
    query?: string;
    turn?: number;
    at?: number;
  },
): SessionSkillInvoked | null {
  const name = entry.name.trim();
  if (!name) return null;

  const rec: SessionSkillInvoked = {
    name,
    action_id: entry.action_id,
    query: entry.query,
    turn: entry.turn,
    at: entry.at ?? Date.now(),
  };

  const list = session.skills_invoked ? [...session.skills_invoked] : [];
  const idx = list.findIndex((s) => s.name === name);
  if (idx >= 0) {
    list[idx] = { ...list[idx]!, ...rec, name };
  } else {
    list.push(rec);
  }

  list.sort((a, b) => a.at - b.at);
  session.skills_invoked =
    list.length > MAX_SKILLS_INVOKED
      ? list.slice(list.length - MAX_SKILLS_INVOKED)
      : list;

  return rec;
}

/** Compact line for compression notice / diagnostics. */
export function formatSkillsInvokedForNotice(
  skills: SessionSkillInvoked[] | undefined,
): string | null {
  if (!skills?.length) return null;
  const parts = skills.map((s) =>
    s.action_id ? `${s.name} (${s.action_id})` : s.name,
  );
  return (
    `Skills this session: ${parts.join(', ')}. ` +
    `Use recall_query(action_id=...) for full skill text if needed.`
  );
}
