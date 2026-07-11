const SKIP_FORMAT = /^\[(aborted|Agent stopped:)/;

export function shouldFormatFinal(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (SKIP_FORMAT.test(t)) return false;
  if (process.env.TUI_MARKDOWN === '0') return false;
  return true;
}