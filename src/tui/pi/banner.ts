/**
 * Startup banner logo + meta lines for TUI.
 * Full block when terminal is wide; one-line mark when narrow.
 */

export const LOGO_FULL_MIN_WIDTH = 52;

/** Multi-line logo (ASCII, no color). */
export function logoFullLines(): string[] {
  return [
    '  ╭─ m·a ──────────────────────────────────╮',
    '  │  minimal-agent-ts                       │',
    '  │  long-context · event cards · TUI       │',
    '  ╰────────────────────────────────────────╯',
  ];
}

/** Compact single-line mark for narrow terminals. */
export function logoCompactLine(): string {
  return '  m·a  minimal-agent-ts  ·  long-context · event cards';
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
