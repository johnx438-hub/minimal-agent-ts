export function extractWorkflowVerdict(text: string): string | undefined {
  const trimmed = text.trim();

  const jsonMatch = trimmed.match(/\{[\s\S]*?"verdict"\s*:\s*"([^"]+)"[\s\S]*?\}\s*$/);
  if (jsonMatch) {
    return jsonMatch[1];
  }

  const loose = trimmed.match(/"verdict"\s*:\s*"(approved|needs_revision)"/i);
  if (loose) {
    return loose[1].toLowerCase();
  }

  if (/needs_revision|needs revision|request changes/i.test(trimmed)) {
    return 'needs_revision';
  }
  if (/approved|lgtm|looks good/i.test(trimmed)) {
    return 'approved';
  }

  return undefined;
}