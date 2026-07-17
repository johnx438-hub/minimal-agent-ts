/**
 * TUI vision attach (SPEC_VISION VI-3):
 * - `@path/to.png` mentions in the prompt line
 * - `/image path` pending buffer until the next chat line
 * Chat shows `[image: path]` placeholders (no pixel render).
 */

import type { VisionRef } from '../types.js';
import {
  guessMimeFromPath,
  visionRefFromPath,
  visionRefFromUrl,
} from '../vision.js';

const DEFAULT_MAX_PENDING = 4;

/**
 * Match `@path`, `@"./path with spaces.png"`, `@'...'`, bare image path / https.
 * Bare path stops at image extension so `布局@./shot.png有重叠` works.
 */
const AT_MENTION_RE =
  /(?:^|(?<=[\s\u0080-\uFFFF]))@(?:"([^"]+)"|'([^']+)'|(https:\/\/\S+?\.(?:png|jpe?g|gif|webp)(?:\?\S*)?)|([^\s@"']+\.(?:png|jpe?g|gif|webp)))/gi;

export function isLikelyImagePath(pathOrUrl: string): boolean {
  const s = pathOrUrl.trim();
  if (!s) return false;
  if (/^https:\/\//i.test(s)) return true;
  return guessMimeFromPath(s) !== undefined;
}

export function visionRefFromUserToken(token: string): VisionRef | null {
  const t = token.trim();
  if (!t) return null;
  if (/^https:\/\//i.test(t)) {
    return visionRefFromUrl(t);
  }
  if (!isLikelyImagePath(t)) return null;
  return visionRefFromPath(t);
}

export interface ParsedVisionLine {
  /** Prompt text with @image tokens removed (whitespace collapsed). */
  text: string;
  /** Refs extracted from @mentions (image extensions / https only). */
  refs: VisionRef[];
  /** Original tokens that became refs (for display). */
  tokens: string[];
}

/**
 * Pull `@./shot.png` style mentions into vision_refs.
 * Non-image `@foo` tokens are left in the text.
 */
export function parseAtImageMentions(line: string): ParsedVisionLine {
  const refs: VisionRef[] = [];
  const tokens: string[] = [];
  let text = line.replace(
    AT_MENTION_RE,
    (
      full,
      quotedD: string,
      quotedS: string,
      httpsUrl: string,
      barePath: string,
    ) => {
      const token = (quotedD ?? quotedS ?? httpsUrl ?? barePath ?? '').trim();
      const ref = visionRefFromUserToken(token);
      if (!ref) return full;
      refs.push(ref);
      tokens.push(token);
      return ' ';
    },
  );
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text, refs, tokens };
}

export function formatImagePlaceholders(refs: VisionRef[]): string {
  return refs
    .map((r) => `[image: ${r.path ?? r.remote_url ?? '?'}]`)
    .join(' ');
}

/** User-visible chat line: caption + placeholders. */
export function formatUserVisionDisplay(
  text: string,
  refs: VisionRef[],
): string {
  const placeholders = formatImagePlaceholders(refs);
  if (!text && !placeholders) return '';
  if (!text) return placeholders;
  if (!placeholders) return text;
  return `${text}\n${placeholders}`;
}

export function mergeVisionRefs(
  ...groups: VisionRef[][]
): VisionRef[] {
  const out: VisionRef[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const r of g) {
      const key = r.path
        ? `p:${r.path}`
        : r.remote_url
          ? `u:${r.remote_url}`
          : `?:${JSON.stringify(r)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

/** Session-scoped pending attach queue for `/image` before the next message. */
export class PendingVisionBuffer {
  private refs: VisionRef[] = [];
  readonly max: number;

  constructor(max = DEFAULT_MAX_PENDING) {
    this.max = max;
  }

  list(): VisionRef[] {
    return [...this.refs];
  }

  clear(): void {
    this.refs = [];
  }

  get length(): number {
    return this.refs.length;
  }

  /**
   * Queue a path or https URL. Returns error message or null on success.
   */
  add(token: string): string | null {
    const ref = visionRefFromUserToken(token);
    if (!ref) {
      return `Not an image path/URL (png/jpg/gif/webp or https): ${token}`;
    }
    if (this.refs.length >= this.max) {
      return `Pending images full (max ${this.max}). Send a message or /image clear.`;
    }
    // Dedup by path/url
    const key = ref.path ?? ref.remote_url ?? '';
    if (
      this.refs.some(
        (r) => (r.path ?? r.remote_url ?? '') === key,
      )
    ) {
      return null; // already queued
    }
    this.refs.push(ref);
    return null;
  }

  /** Drain for the next runTask (empties buffer). */
  take(): VisionRef[] {
    const out = this.refs;
    this.refs = [];
    return out;
  }

  /** Peek + format for status. */
  formatStatus(): string {
    if (!this.refs.length) return '(no pending images)';
    return this.refs
      .map((r, i) => `  ${i + 1}. ${r.path ?? r.remote_url}`)
      .join('\n');
  }
}

/**
 * Combine pending buffer + @mentions for a submit line.
 * Does not drain the buffer — caller should take() after success path chosen.
 */
export function composeVisionSubmit(
  line: string,
  pending: VisionRef[],
): {
  text: string;
  refs: VisionRef[];
  display: string;
} {
  const parsed = parseAtImageMentions(line);
  const refs = mergeVisionRefs(pending, parsed.refs);
  const text = parsed.text;
  return {
    text,
    refs,
    display: formatUserVisionDisplay(text, refs),
  };
}
