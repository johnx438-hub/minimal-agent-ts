import type { ResolvedLlmBinding } from './llm-profiles.js';

export function listReasoningLevels(
  reasoningMap: Record<string, Record<string, unknown>> | undefined,
): string[] {
  if (!reasoningMap) return [];
  return Object.keys(reasoningMap).sort();
}

/** Resolve a named level from profile reasoning_map (G4). */
export function resolveReasoningPatch(
  reasoningMap: Record<string, Record<string, unknown>> | undefined,
  level: string,
): Record<string, unknown> | undefined {
  const key = level.trim();
  if (!key || !reasoningMap) return undefined;
  const patch = reasoningMap[key];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return undefined;
  }
  return { ...patch };
}

/** Session reasoning patch for the effective profile binding. */
export function buildSessionReasoningExtraBody(
  binding: Pick<ResolvedLlmBinding, 'reasoningMap'>,
  sessionReasoningLevel?: string,
): Record<string, unknown> | undefined {
  const level = sessionReasoningLevel?.trim();
  if (!level) return undefined;
  return resolveReasoningPatch(binding.reasoningMap, level);
}