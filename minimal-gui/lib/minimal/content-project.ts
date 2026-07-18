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
