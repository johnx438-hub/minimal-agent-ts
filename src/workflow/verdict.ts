const VERDICT_VALUES = new Set(['approved', 'needs_revision', 'needs_human']);

/**
 * Map free-form / tool-submitted verdict strings onto the three protocol values.
 * Used by text extractors and structured workflow_handoff.verdict.
 */
export function normalizeWorkflowVerdict(raw: string): string | undefined {
  const v = raw.trim().toLowerCase().replace(/\s+/g, '_');
  if (VERDICT_VALUES.has(v)) return v;
  if (v === 'needs-human' || v === 'need_human' || v === 'need-human') {
    return 'needs_human';
  }
  if (
    v === 'request_changes' ||
    v === 'changes_requested' ||
    v === 'needs-revision' ||
    v === 'need_revision'
  ) {
    return 'needs_revision';
  }
  // Common synonyms (models often say pass / approve instead of approved)
  if (
    v === 'lgtm' ||
    v === 'approve' ||
    v === 'pass' ||
    v === 'passed' ||
    v === 'passes' ||
    v === 'ok' ||
    v === 'okay'
  ) {
    return 'approved';
  }
  return undefined;
}

/** @deprecated alias — prefer normalizeWorkflowVerdict */
export const normalizeVerdict = normalizeWorkflowVerdict;

export function extractWorkflowVerdict(text: string): string | undefined {
  const trimmed = text.trim();

  const jsonMatch = trimmed.match(
    /\{[\s\S]*?"verdict"\s*:\s*"([^"]+)"[\s\S]*?\}\s*$/,
  );
  if (jsonMatch?.[1]) {
    const n = normalizeWorkflowVerdict(jsonMatch[1]);
    if (n) return n;
  }

  // Any quoted verdict value, then normalize (pass/approve/…)
  const loose = trimmed.match(/"verdict"\s*:\s*"([^"]+)"/i);
  if (loose?.[1]) {
    const n = normalizeWorkflowVerdict(loose[1]);
    if (n) return n;
  }

  if (/needs_human|needs human|ask (the )?user|unclear goal/i.test(trimmed)) {
    return 'needs_human';
  }
  if (/needs_revision|needs revision|request changes/i.test(trimmed)) {
    return 'needs_revision';
  }
  if (
    /\bapproved\b|\blgtm\b|\blooks good\b|\bapprove\b|\bpass(?:ed|es)?\b/i.test(
      trimmed,
    )
  ) {
    return 'approved';
  }

  return undefined;
}
