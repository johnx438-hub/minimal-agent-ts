/**
 * Infer real tool names / paths from bridge previews when tool_name is missing or "tool".
 */

/** File / content mutations — write-card preview (path + clip). */
const MUTATING = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "office_write",
]);

/** Shell / test runners — shell-card preview (longer output clip). */
const SHELLISH = new Set(["run_shell", "test_run"]);

const READISH = new Set([
  "read_file",
  "grep_search",
  "list_files",
  "diff_file",
  "recall_query",
  "web_fetch",
  "web_search",
]);

export type ToolSkin = "read" | "write" | "shell" | "spawn" | "generic";

/** spawn_agent / spawn_background / code_review — full child text must not flood main chat. */
export function isSpawnDelegationTool(toolName: string | undefined): boolean {
  const n = (toolName ?? "").toLowerCase();
  return (
    n === "spawn_agent" ||
    n === "spawn_background" ||
    n === "code_review" ||
    n.startsWith("spawn_")
  );
}

export function toolSkin(toolName: string): ToolSkin {
  const n = toolName.toLowerCase();
  if (isSpawnDelegationTool(n)) return "spawn";
  // Shell before write: names like run_shell must not hit write heuristics.
  if (SHELLISH.has(n) || n.includes("shell")) {
    return "shell";
  }
  if (MUTATING.has(n) || n.includes("write") || n.includes("edit") || n.includes("patch")) {
    return "write";
  }
  if (READISH.has(n) || n.includes("read") || n.includes("grep") || n.includes("list")) {
    return "read";
  }
  return "generic";
}

/** Compact one-screen summary for delegation tool results (never dump full child report). */
export function formatSpawnDelegationPreview(
  toolName: string,
  content: string,
  argsJson?: string,
): string {
  let preset = "";
  let jobId = "";
  try {
    if (argsJson?.trim()) {
      const o = JSON.parse(argsJson) as { preset?: string; job_id?: string };
      if (typeof o.preset === "string") preset = o.preset.trim();
      if (typeof o.job_id === "string") jobId = o.job_id.trim();
    }
  } catch {
    /* ignore */
  }
  const body = restorePreviewNewlines(content ?? "").trim();
  const first = body.split("\n").find((l) => l.trim())?.trim() ?? "";
  // spawn_background: started job_xxx (skeleton-reader)
  const started = body.match(
    /spawn_background:\s*(started|completed|failed)\s+(\S+)(?:\s*\(([^)]+)\))?/i,
  );
  if (started) {
    const status = started[1]!;
    const id = started[2]!;
    const p = started[3] || preset;
    return [
      p ? `子任务 · ${p}` : "子任务",
      `${status} ${id}`,
      "（详情在 Jobs 面板 / report，默认不展开正文）",
    ].join("\n");
  }
  const head =
    first.length > 160 ? `${first.slice(0, 160)}…` : first || "(empty)";
  const chars = body.length;
  const lines = body ? body.split("\n").length : 0;
  return [
    preset ? `子 Agent · ${preset}` : `子 Agent · ${toolName}`,
    jobId ? `job: ${jobId}` : null,
    head.startsWith("error:") ? head : `摘要: ${head}`,
    chars > 280
      ? `… 共 ${lines} 行 / ${chars} 字（骨架类 preset 很啰嗦，点展开才看全文）`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Prefer short chip under tool title (preset name). */
export function inferSpawnPresetLabel(
  content: string | undefined,
  argsJson?: string,
): string | undefined {
  try {
    if (argsJson?.trim()) {
      const o = JSON.parse(argsJson) as { preset?: string };
      if (typeof o.preset === "string" && o.preset.trim()) return o.preset.trim();
    }
  } catch {
    /* ignore */
  }
  const c = content ?? "";
  const m =
    c.match(/\(([^)]*(?:reader|worker|review|agent)[^)]*)\)/i) ||
    c.match(/preset[=:]\s*([A-Za-z0-9_-]+)/i);
  if (m?.[1] && m[1].length < 48) return m[1].trim();
  return undefined;
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
    /(?:^|\b)(read_file|write_file|edit_file|apply_patch|grep_search|list_files|diff_file|recall_query|run_shell|web_fetch|web_search|office_read|office_write|invoke_skill|test_run|vision_attach)\b/i,
  );
  if (head?.[1]) return head[1];

  if (c.includes("[vision_attach]") || c.startsWith("[vision_attach]")) {
    return "vision_attach";
  }

  // action card line sometimes embeds name=
  const named = c.match(/tool[_ ]?name["']?\s*[:=]\s*["']?([\w.-]+)/i);
  if (named?.[1]) return named[1];

  return t || "tool";
}

const WRITE_DISPLAY_START = "\n[write_display]\n";
const WRITE_DISPLAY_END = "\n[/write_display]";
const EDIT_DISPLAY_START = "\n[edit_display]\n";
const EDIT_DISPLAY_END = "\n[/edit_display]";

/** Split agent summary from UI-only display block (mirrors server write/edit-display). */
export function splitToolUiDisplay(raw: string): {
  summary: string;
  display?: string;
  kind?: "write" | "edit";
} {
  const trySplit = (
    start: string,
    end: string,
    kind: "write" | "edit",
  ): { summary: string; display?: string; kind?: "write" | "edit" } | null => {
    const s = raw.indexOf(start);
    if (s < 0) return null;
    const e = raw.indexOf(end, s + start.length);
    if (e < 0) return null;
    return {
      summary: raw.slice(0, s).trimEnd(),
      display: raw.slice(s + start.length, e),
      kind,
    };
  };
  return (
    trySplit(EDIT_DISPLAY_START, EDIT_DISPLAY_END, "edit") ??
    trySplit(WRITE_DISPLAY_START, WRITE_DISPLAY_END, "write") ??
    trySplit("[write_display]\n", "\n[/write_display]", "write") ??
    trySplit("[edit_display]\n", "\n[/edit_display]", "edit") ?? {
      summary: raw,
    }
  );
}

/** Best-effort path for title chip. */
export function inferToolPath(content: string | undefined): string | undefined {
  const c = content ?? "";
  // vision_attach JSON: {"path":"workspace/gui-inbox/..."}
  const visionPath = c.match(
    /\[vision_attach\]\s*\{[^}]*"path"\s*:\s*"([^"]+)"/,
  );
  if (visionPath?.[1] && visionPath[1].length < 200) return visionPath[1];

  // ok: wrote N bytes to /abs/or/rel/path (new file)
  const wrote = c.match(
    /ok:\s*wrote\s+\d+\s+bytes\s+to\s+(\S+?)(?:\s+\(|$)/i,
  );
  if (wrote?.[1] && wrote[1].length < 240) return wrote[1];

  // ok: edited /path/file.ts (
  const edited = c.match(/ok:\s*edited\s+(\S+?)(?:\s+\(|$)/i);
  if (edited?.[1] && edited[1].length < 240) return edited[1];

  const quoted = c.match(/["'`]([^"'`\n]+\.[a-zA-Z0-9]{1,8})["'`]/);
  if (quoted?.[1] && quoted[1].length < 120) return quoted[1];
  const pathy = c.match(/(?:^|\s)([\w./-]+\.[a-zA-Z0-9]{1,8})(?:\s|$|:)/);
  if (pathy?.[1] && pathy[1].length < 120 && !pathy[1].startsWith("http")) {
    return pathy[1];
  }
  return undefined;
}

/** Rebuild a minimal unified diff from edit args when display was stripped. */
export function diffFromEditArgs(argsJson?: string): string | undefined {
  if (!argsJson?.trim()) return undefined;
  try {
    const o = JSON.parse(argsJson) as {
      path?: string;
      old_string?: string;
      new_string?: string;
    };
    const oldS = o.old_string ?? "";
    const newS = o.new_string ?? "";
    if (!oldS && !newS) return undefined;
    const path = o.path?.trim() || "file";
    const oldLines = oldS.replace(/\r\n/g, "\n").split("\n");
    const newLines = newS.replace(/\r\n/g, "\n").split("\n");
    return [
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.map((l) => `-${l}`),
      ...newLines.map((l) => `+${l}`),
    ].join("\n");
  } catch {
    return undefined;
  }
}

/** Prefer write content from args when result is only an ok: summary. */
export function contentFromWriteArgs(argsJson?: string): string | undefined {
  if (!argsJson?.trim()) return undefined;
  try {
    const o = JSON.parse(argsJson) as { content?: string };
    if (typeof o.content === "string" && o.content.length > 0) return o.content;
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Undo live-preview flattening that turned real newlines into the two-char
 * sequence "\\n" (see formatLiveToolPreview history). Heuristic: many escaped
 * newlines and almost no real ones → restore. Avoids mangling source that only
 * contains a few intentional \\n string literals in multi-line files.
 */
export function restorePreviewNewlines(text: string): string {
  if (!text || !text.includes("\\n")) return text;
  const realNl = (text.match(/\n/g) ?? []).length;
  const escNl = (text.match(/\\n/g) ?? []).length;
  if (escNl < 2) return text;
  if (realNl >= 3 && escNl <= realNl) return text;
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

/** Compact tree-ish preview for read tools (Nice01 direction). */
export function formatReadTreePreview(
  toolName: string,
  content: string,
  path?: string,
): string {
  const lines = restorePreviewNewlines(content)
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
