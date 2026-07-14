/**
 * Startup banner logo + meta lines for TUI.
 * Full: large block-letter MINIMAL; narrow: compact one-liner.
 */

/** Min columns for the 5-row block logo (incl. leading indent). */
export const LOGO_FULL_MIN_WIDTH = 62;

/**
 * 5-row heavy glyphs (█ / space). Each letter is 5 wide + 1 gap when joined.
 * Designed for word MINIMAL only (subset of A–Z used).
 */
const GLYPH_H = 5;
const GLYPHS: Record<string, readonly string[]> = {
  M: [
    '██   ██',
    '███ ███',
    '██ █ ██',
    '██   ██',
    '██   ██',
  ],
  I: [
    '██',
    '██',
    '██',
    '██',
    '██',
  ],
  N: [
    '██   ██',
    '███  ██',
    '██ █ ██',
    '██  ███',
    '██   ██',
  ],
  A: [
    ' ████ ',
    '██  ██',
    '██████',
    '██  ██',
    '██  ██',
  ],
  L: [
    '██    ',
    '██    ',
    '██    ',
    '██    ',
    '██████',
  ],
};

const WORD = 'MINIMAL';

/** Join glyphs for WORD into 5 full-width lines (no indent). */
export function renderBlockWord(word: string = WORD): string[] {
  const upper = word.toUpperCase();
  const rows: string[] = Array.from({ length: GLYPH_H }, () => '');
  for (let i = 0; i < upper.length; i++) {
    const ch = upper[i]!;
    const glyph = GLYPHS[ch];
    if (!glyph) continue;
    const gap = i === 0 ? '' : ' ';
    for (let r = 0; r < GLYPH_H; r++) {
      rows[r] = `${rows[r]}${gap}${glyph[r]}`;
    }
  }
  return rows;
}

/** Multi-line block MINIMAL with left indent. */
export function logoFullLines(): string[] {
  return renderBlockWord(WORD).map((line) => `  ${line}`);
}

/** Compact single-line mark for narrow terminals. */
export function logoCompactLine(): string {
  return '  MINIMAL';
}

/**
 * Logo lines for the given terminal width (columns).
 * @param width process.stdout.columns or similar; undefined → full logo
 */
export function renderLogoLines(width?: number): string[] {
  const w = width && width > 0 ? width : 80;
  if (w < LOGO_FULL_MIN_WIDTH) return [logoCompactLine()];
  return logoFullLines();
}

export interface BannerMetaInput {
  model: string;
  cwd: string;
  sessionLabel: string;
  shellOn: boolean;
  webOn: boolean;
  hasActiveSession: boolean;
  hasPendingHandoff: boolean;
  alwaysShell?: boolean;
  alwaysWeb?: boolean;
  /** Short locale tag for status, e.g. zh / en */
  locale?: string;
}

/** Status / help lines under the logo (no logo itself). */
export function buildBannerMetaLines(input: BannerMetaInput): string[] {
  const lines = [
    `  model:   ${input.model}`,
    `  cwd:     ${input.cwd}`,
    `  session: ${input.sessionLabel}`,
    `  shell:   ${input.shellOn ? 'on' : 'off'}   web: ${input.webOn ? 'on' : 'off'}` +
      (input.locale ? `   lang: ${input.locale}` : ''),
    '  Enter send · Esc stop (confirm) · /help · /lang · /stop',
  ];

  if (!input.hasActiveSession) {
    lines.push('  (no session yet — /resume, /new, or first task)');
    lines.push('  CLI: npm run tui -- --resume <session_id>');
  }
  if (input.hasPendingHandoff) {
    lines.push('  (brief queued — will inject on next task)');
  }
  if (input.alwaysShell || input.alwaysWeb) {
    const always: string[] = [];
    if (input.alwaysShell) always.push('shell');
    if (input.alwaysWeb) always.push('web');
    lines.push(`  ⚠ always-approve: ${always.join(', ')}`);
  }
  return lines;
}

/** Full banner text for tests / plain dump. */
export function buildBannerText(
  input: BannerMetaInput,
  width?: number,
): string {
  return [...renderLogoLines(width), ...buildBannerMetaLines(input)].join('\n');
}
