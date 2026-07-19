/**
 * Empty-thread welcome lines (CN / EN, ready-to-serve tone).
 * Stable per session via hash; changes on new session.
 */

export const WELCOME_GREETINGS: string[] = [
  "在的，随时说。",
  "Ready when you are.",
  "有事直接丢过来。",
  "Standing by.",
  "这边，听你的。",
  "What are we working on?",
  "准备好了，你开口就行。",
  "Say the word.",
  "待命中。",
  "Here — take your time.",
  "需要什么尽管讲。",
  "On standby.",
];

/** Simple string hash → non-negative int */
export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function pickWelcomeGreeting(seed: string | null | undefined): string {
  const list = WELCOME_GREETINGS;
  if (!list.length) return "Ready when you are.";
  const key = seed?.trim() || "default";
  return list[hashString(key) % list.length]!;
}
