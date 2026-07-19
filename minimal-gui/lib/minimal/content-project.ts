/**
 * Client-side projection mirrors harness summary.ts (extractCleanAnswer / parseAgentSummary).
 * Keep in sync when server format changes.
 */

const JSON_TAIL =
  /\n*\{["']?pending_tasks["']?\s*:\s*\[[^\]]*\]\s*,\s*["']?current_work["']?\s*:\s*"[^"]*"\}$/i;

export interface AgentSummaryFields {
  pending_tasks: string[];
  current_work: string;
}

export function extractCleanAnswer(finalAnswer: string): string {
  const match = finalAnswer.match(JSON_TAIL);
  if (match && match.index !== undefined) {
    return finalAnswer.slice(0, match.index).trim();
  }
  return finalAnswer.trim();
}

export function parseAgentSummary(finalAnswer: string): AgentSummaryFields {
  const match = finalAnswer.match(JSON_TAIL);
  if (!match) return { pending_tasks: [], current_work: "" };
  try {
    const raw = match[0];
    let parsed: { pending_tasks?: unknown; current_work?: unknown };
    try {
      parsed = JSON.parse(raw) as {
        pending_tasks?: unknown;
        current_work?: unknown;
      };
    } catch {
      const normalized = raw
        .replace(/'/g, '"')
        .replace(/(\w+)\s*:/g, '"$1":');
      parsed = JSON.parse(normalized) as {
        pending_tasks?: unknown;
        current_work?: unknown;
      };
    }
    return {
      pending_tasks: Array.isArray(parsed.pending_tasks)
        ? parsed.pending_tasks.map(String)
        : [],
      current_work:
        typeof parsed.current_work === "string" ? parsed.current_work : "",
    };
  } catch {
    return { pending_tasks: [], current_work: "" };
  }
}

export function looksLikeArtifact(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  if (t.startsWith("[action:")) return true;
  if (t.includes("…[truncated]") || t.includes("...[truncated]")) return true;
  if (/^\[pointer/i.test(t)) return true;
  return false;
}

/** Mirror of server session-chat-history projectUserBody (display only). */
const WD_TASK_RE = /^Working directory:\s*[^\n]+\n\nTask:\n([\s\S]*)$/;
const WD_WORKFLOW_RE = /^Working directory task \(workflow\):\n?([\s\S]*)$/i;
const SYSTEM_EVENT_OPEN = '<system_event not_user_message="true">';
const SYSTEM_EVENT_CLOSE = "</system_event>";
/** Injected by harness after vision tools — not a human turn. */
const VISION_INJECT_RE =
  /^Attached image\(s\) for vision\b[\s\S]*/i;

export function isVisionInjectUserMessage(raw: string): boolean {
  const t = (raw ?? "").replace(/\r\n/g, "\n").trim();
  // After Working directory unwrap, body starts with this line
  if (VISION_INJECT_RE.test(t)) return true;
  if (t.includes("Attached image(s) for vision")) return true;
  return false;
}

export function extractVisionInjectPaths(raw: string): string[] {
  const text = (raw ?? "").replace(/\r\n/g, "\n");
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith("Attached image") &&
        (l.includes("/") || l.includes("\\")),
    );
}

export function projectUserDisplay(raw: string): {
  content: string;
  role: "user" | "system";
  viewKind: "chat" | "system_ui";
  /** Paths lifted for chips when role stays user or system */
  attachmentPaths?: string[];
} {
  let body = (raw ?? "").replace(/\r\n/g, "\n");
  const wd = body.match(WD_TASK_RE);
  if (wd) body = wd[1] ?? body;

  const wf = body.match(WD_WORKFLOW_RE);
  if (wf) {
    return {
      content: (wf[1] ?? body).trim(),
      role: "system",
      viewKind: "system_ui",
    };
  }

  // Vision tool → synthetic user (pixels for next LLM turn). Never show as human bubble.
  if (isVisionInjectUserMessage(body)) {
    const paths = extractVisionInjectPaths(body);
    const names = paths.map((p) => p.split("/").pop() || p);
    return {
      content: names.length
        ? `🖼 vision · ${names.join(", ")}`
        : "🖼 vision attachment",
      role: "system",
      viewKind: "system_ui",
      attachmentPaths: paths,
    };
  }

  const looksSynthetic =
    body.trimStart().startsWith(SYSTEM_EVENT_OPEN) ||
    body.includes("[system_event · not a user message]");
  if (looksSynthetic) {
    let display = body
      .replace(SYSTEM_EVENT_OPEN, "")
      .replace(SYSTEM_EVENT_CLOSE, "")
      .replace(
        /You are the main agent\. This is NOT a human user message\.[\s\S]*$/m,
        "",
      )
      .trim()
      .replace(/\n{3,}/g, "\n\n");
    return {
      content: display || body.trim(),
      role: "system",
      viewKind: "system_ui",
    };
  }

  return { content: body.trim(), role: "user", viewKind: "chat" };
}

/** Markdown block visually distinct from body (blockquote + bold header). */
export function formatPendingCardMarkdown(meta: {
  pending_tasks?: string[];
  current_work?: string;
}): string {
  const tasks = meta.pending_tasks ?? [];
  const work = meta.current_work?.trim();
  if (!tasks.length && !work) return "";
  const lines = ["", "---", "", "> **📋 任务摘要**", ">"];
  if (work) {
    lines.push(`> **进展** · ${work}`, ">");
  }
  if (tasks.length) {
    lines.push("> **待办**");
    for (const t of tasks) {
      lines.push(`> - [ ] ${t}`);
    }
  }
  return lines.join("\n");
}

export function formatArtifactMarkdown(content: string): string {
  const short =
    content.length > 160 ? `${content.slice(0, 160).trim()}…` : content.trim();
  return [
    "",
    "---",
    "",
    "> **📦 已压缩上下文**",
    ">",
    `> \`${short.replace(/`/g, "'")}\``,
    ">",
    "> _旧轮次工具/指针结果，默认折叠展示；完整内容可在 action store / debug 视图查看。_",
  ].join("\n");
}
