/**
 * Web tool display tiers — aligned with TUI tool-compact.ts
 * rich: write/edit env mutations
 * shell_fold: shell/test — default collapsed, fail/running open
 * spawn: delegation — never auto-expand
 * breadcrumb: read/list/grep/… — no card body by default
 */

import { isSpawnDelegationTool } from "./tool-parse";

export type ToolDisplayTier = "rich" | "shell_fold" | "spawn" | "breadcrumb";

const RICH = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "office_write",
]);

const SHELL = new Set(["run_shell", "test_run"]);

export function toolDisplayTier(toolName: string | undefined): ToolDisplayTier {
  const n = (toolName ?? "").toLowerCase();
  if (isSpawnDelegationTool(n)) return "spawn";
  if (RICH.has(n)) return "rich";
  if (SHELL.has(n) || n.includes("shell")) return "shell_fold";
  return "breadcrumb";
}

export function isToolResultFailure(
  content: string | undefined,
  status?: string,
): boolean {
  if (status === "incomplete") return true;
  const t = (content ?? "").trim();
  if (!t) return false;
  if (t.startsWith("error:") || t.startsWith("[aborted]")) return true;
  if (/^error:\s*exit\s+\d+/im.test(t)) return true;
  return false;
}

/**
 * Whether a tool card should start expanded.
 * Manual expand always allowed in UI regardless.
 */
export function shouldAutoExpandTool(opts: {
  toolName: string | undefined;
  content?: string;
  status?: string;
  inLatestTurn?: boolean;
}): boolean {
  const tier = toolDisplayTier(opts.toolName);
  const failed = isToolResultFailure(opts.content, opts.status);
  const running = opts.status === "running";

  if (tier === "spawn") return false;
  if (tier === "breadcrumb") return failed; // only failures surface as cards
  if (tier === "shell_fold") return failed || running;
  // rich: open while running, after fail, or still in latest user turn when complete
  return running || failed || Boolean(opts.inLatestTurn);
}

/** One-line live status for spinner strip. */
export function formatToolLiveLabel(
  toolName: string | undefined,
  content?: string,
  path?: string,
): string {
  const n = toolName || "tool";
  if (path) return `${n} · ${path.length > 48 ? `…${path.slice(-46)}` : path}`;
  const first = (content ?? "").trim().split("\n")[0] ?? "";
  if (first.length > 56) return `${n} · ${first.slice(0, 56)}…`;
  if (first) return `${n} · ${first}`;
  return n;
}
