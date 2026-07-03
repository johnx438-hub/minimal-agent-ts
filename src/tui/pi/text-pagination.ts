/** Clamp scroll offset for a viewport over wrapped lines. */
export function clampLineOffset(
  offset: number,
  totalLines: number,
  visibleLines: number,
): number {
  if (totalLines <= 0) return 0;
  const maxOffset = Math.max(0, totalLines - visibleLines);
  return Math.max(0, Math.min(offset, maxOffset));
}

/** Advance offset by one page (visible window). */
export function pageOffset(
  offset: number,
  totalLines: number,
  visibleLines: number,
  direction: -1 | 1,
): number {
  const delta = visibleLines * direction;
  return clampLineOffset(offset + delta, totalLines, visibleLines);
}

export function formatScrollFooter(
  offset: number,
  totalLines: number,
  visibleLines: number,
): string {
  if (totalLines === 0) {
    return '(empty) · Esc back';
  }
  const start = offset + 1;
  const end = Math.min(offset + visibleLines, totalLines);
  const pageHint =
    totalLines > visibleLines
      ? ' · ←/→ page · ↑/↓ scroll'
      : '';
  return `lines ${start}–${end}/${totalLines}${pageHint} · Esc back`;
}