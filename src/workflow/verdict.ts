const VERDICT_VALUES = new Set(['approved', 'needs_revision', 'needs_human']);

function normalizeVerdict(raw: string): string | undefined {
  const v = raw.trim().toLowerCase().replace(/\s+/g, '_');
  if (VERDICT_VALUES.has(v)) return v;
  if (v === 'needs-human' || v === 'need_human') return 'needs_human';
  if (v === 'request_changes' || v === 'changes_requested') return 'needs_revision';
  if (v === 'lgtm' || v === 'approve') return 'approved';
  return undefined;
}

export function extractWorkflowVerdict(text: string): string | undefined {
  const trimmed = text.trim();

  const jsonMatch = trimmed.match(/\{[\s\S]*?"verdict"\s*:\s*"([^"]+)"[\s\S]*?\}\s*$/);
  if (jsonMatch?.[1]) {
    const n = normalizeVerdict(jsonMatch[1]);
    if (n) return n;
  }

  const loose = trimmed.match(
    /"verdict"\s*:\s*"(approved|needs_revision|needs_human)"/i,
  );
  if (loose?.[1]) {
    return normalizeVerdict(loose[1]);
  }

  if (/needs_human|needs human|ask (the )?user|unclear goal/i.test(trimmed)) {
    return 'needs_human';
  }
  if (/needs_revision|needs revision|request changes/i.test(trimmed)) {
    return 'needs_revision';
  }
  if (/approved|lgtm|looks good/i.test(trimmed)) {
    return 'approved';
  }

  return undefined;
}