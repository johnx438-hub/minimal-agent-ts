/**
 * Infer real tool names / paths from bridge previews when tool_name is missing or "tool".
 */

const MUTATING = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "office_write",
  "run_shell",
  "test_run",
]);

const READISH = new Set([
  "read_file",
  "grep_search",
  "list_files",
  "diff_file",
  "recall_query",
  "web_fetch",
  "web_search",
]);

export type ToolSkin = "read" | "write" | "shell" | "generic";

export function toolSkin(toolName: string): ToolSkin {
  const n = toolName.toLowerCase();
  if (MUTATING.has(n) || n.includes("write") || n.includes("edit") || n.includes("patch")) {
    return "write";
  }
  if (n === "run_shell" || n.includes("shell")) return "shell";
  if (READISH.has(n) || n.includes("read") || n.includes("grep") || n.includes("list")) {
    return "read";
  }
  return "generic";
}

/** Prefer bridge tool_name; fall back to preview heuristics. */
export function inferToolName(
  toolName: string | undefined,
  content: string | undefined,
): string {
  const t = toolName?.trim();
  if (t && t !== "tool" && t !== "unknown") return t;

  const c = (content ?? "").trim();
  if (!c) return "tool";

  // Common previews: "read_file path/to" / "read_file(path)" / "✓ read_file"
  const head = c.match(
    /(?:^|\b)(read_file|write_file|edit_file|apply_patch|grep_search|list_files|diff_file|recall_query|run_shell|web_fetch|web_search|office_read|office_write|invoke_skill|test_run)\b/i,
  );
  if (head?.[1]) return head[1];

  // action card line sometimes embeds name=
  const named = c.match(/tool[_ ]?name["']?\s*[:=]\s*["']?([\w.-]+)/i);
  if (named?.[1]) return named[1];

  return t || "tool";
}

/** Best-effort path for title chip. */
export function inferToolPath(content: string | undefined): string | undefined {
  const c = content ?? "";
  const quoted = c.match(/["'`]([^"'`\n]+\.[a-zA-Z0-9]{1,8})["'`]/);
  if (quoted?.[1] && quoted[1].length < 120) return quoted[1];
  const pathy = c.match(/(?:^|\s)([\w./-]+\.[a-zA-Z0-9]{1,8})(?:\s|$|:)/);
  if (pathy?.[1] && pathy[1].length < 120 && !pathy[1].startsWith("http")) {
    return pathy[1];
  }
  return undefined;
}

/** Compact tree-ish preview for read tools (Nice01 direction). */
export function formatReadTreePreview(
  toolName: string,
  content: string,
  path?: string,
): string {
  const lines = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(0, 14);
  const title = path
    ? `${toolName}("${path}")`
    : `${toolName}()`;
  if (lines.length === 0) return title;
  const body = lines
    .map((l, i) => {
      const prefix = i === lines.length - 1 ? "└─ " : "├─ ";
      const clip = l.length > 100 ? `${l.slice(0, 100)}…` : l;
      return prefix + clip;
    })
    .join("\n");
  return `${title}\n${body}`;
}

/** Pending-style summary for write tools. */
export function formatWriteCardPreview(
  toolName: string,
  content: string,
  path?: string,
): string {
  const pathLine = path ? path : "（路径见结果）";
  const clip =
    content.length > 280 ? `${content.slice(0, 280).trim()}…` : content.trim();
  return [`✓ ${toolName}`, pathLine, clip].filter(Boolean).join("\n");
}
