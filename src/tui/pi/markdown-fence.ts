/** Pick a Markdown fence long enough to wrap `body` safely. */
export function pickCodeFence(body: string): string {
  let ticks = 3;
  for (const match of body.matchAll(/`{3,}/g)) {
    ticks = Math.max(ticks, match[0].length + 1);
  }
  return '`'.repeat(ticks);
}