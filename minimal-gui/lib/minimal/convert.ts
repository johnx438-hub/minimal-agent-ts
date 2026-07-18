import type { ThreadMessageLike } from "@assistant-ui/react";

import {
  extractCleanAnswer,
  formatArtifactMarkdown,
  formatPendingCardMarkdown,
  looksLikeArtifact,
  parseAgentSummary,
} from "./content-project";
import type { MinimalMessage, SessionChatMessageDto } from "./types";

let idSeq = 0;
export function newMsgId(prefix = "m"): string {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq}`;
}

/** After history load: only tools after the last user message stay expanded. */
export function applyToolExpandPolicy(
  messages: MinimalMessage[],
): MinimalMessage[] {
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") lastUserIdx = i;
  }
  return messages.map((m, i) => {
    if (m.role !== "tool") return m;
    const inLatestTurn = lastUserIdx >= 0 && i > lastUserIdx;
    const expanded =
      m.status === "running" || m.toolExpanded === true
        ? true
        : inLatestTurn;
    return { ...m, toolExpanded: expanded };
  });
}

/**
 * When a run ends, collapse tools not in the latest user turn.
 * Keep latest-turn tools expanded.
 */
export function collapseToolsExceptLatestTurn(
  messages: MinimalMessage[],
): MinimalMessage[] {
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") lastUserIdx = i;
  }
  return messages.map((m, i) => {
    if (m.role !== "tool") {
      if (m.role === "assistant" && m.status === "running") {
        return { ...m, status: "complete" as const };
      }
      return m;
    }
    const inLatestTurn = lastUserIdx >= 0 && i > lastUserIdx;
    return {
      ...m,
      status: m.status === "running" ? ("complete" as const) : m.status,
      toolExpanded: inLatestTurn,
    };
  });
}

function buildAssistantDisplayText(message: MinimalMessage): string {
  let body = message.content ?? "";
  if (message.viewKind === "artifact" || message.meta?.artifact) {
    return formatArtifactMarkdown(body);
  }
  const card = formatPendingCardMarkdown(message.meta ?? {});
  if (card) return `${body.trimEnd()}${card}`;
  return body;
}

/** Store message → assistant-ui ThreadMessageLike */
export function convertMessage(message: MinimalMessage): ThreadMessageLike {
  if (message.role === "tool") {
    const toolName = message.toolName || "tool";
    const toolCallId = message.callId || message.id;
    const expand =
      message.toolExpanded === true || message.status === "running";
    const running = message.status === "running";
    return {
      id: message.id,
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName,
          args: {},
          argsText: "",
          result: {
            preview: message.content || "(empty)",
            // Consumed by ToolFallback expand policy
            _expand: expand,
          },
          // running keeps ToolFallback spinner + default open behavior we add
          status: running
            ? { type: "running" }
            : { type: "complete", reason: "stop" },
        } as never,
      ],
      status: running
        ? { type: "running" }
        : { type: "complete", reason: "stop" },
    };
  }

  if (message.role === "system") {
    return {
      id: message.id,
      role: "system",
      content: [{ type: "text", text: message.content }],
    };
  }

  if (message.role === "assistant") {
    return {
      id: message.id,
      role: "assistant",
      content: [{ type: "text", text: buildAssistantDisplayText(message) }],
      status:
        message.status === "running"
          ? { type: "running" }
          : { type: "complete", reason: "stop" },
    };
  }

  return {
    id: message.id,
    role: "user",
    content: [{ type: "text", text: message.content }],
  };
}

export function fromHistoryDto(row: SessionChatMessageDto): MinimalMessage {
  const raw = row.content ?? "";
  if (row.role === "assistant") {
    const summary = row.meta ?? parseAgentSummary(raw);
    const clean = row.meta ? raw : extractCleanAnswer(raw);
    const artifact =
      row.view_kind === "artifact" ||
      row.meta?.artifact ||
      looksLikeArtifact(clean);
    return {
      id: newMsgId("hist"),
      role: "assistant",
      content: clean,
      status: "complete",
      turn: row.turn,
      taskId: row.task_id,
      source: row.source,
      meta:
        summary.pending_tasks?.length || summary.current_work || artifact
          ? {
              pending_tasks: summary.pending_tasks,
              current_work: summary.current_work,
              artifact: artifact || undefined,
            }
          : undefined,
      viewKind: artifact ? "artifact" : row.view_kind ?? "chat",
    };
  }

  if (row.role === "tool") {
    return {
      id: newMsgId("hist"),
      role: "tool",
      content: raw,
      status: "complete",
      toolName: row.tool_name,
      callId: row.action_id,
      turn: row.turn,
      taskId: row.task_id,
      source: row.source,
      viewKind: "tool",
      toolExpanded: false, // policy applied later
    };
  }

  return {
    id: newMsgId("hist"),
    role: row.role === "system" ? "system" : "user",
    content: raw,
    status: "complete",
    turn: row.turn,
    taskId: row.task_id,
    source: row.source,
    viewKind: row.role === "system" ? "system_ui" : "chat",
  };
}

export function textFromAppendContent(
  content: readonly { type: string; text?: string }[],
): string {
  const part = content.find((c) => c.type === "text");
  return part && "text" in part && typeof part.text === "string"
    ? part.text
    : "";
}

/** Project live assistant final text: clean + meta. */
export function projectAssistantFinal(raw: string): {
  content: string;
  meta?: MinimalMessage["meta"];
  viewKind: MinimalMessage["viewKind"];
} {
  const summary = parseAgentSummary(raw);
  const clean = extractCleanAnswer(raw);
  if (looksLikeArtifact(clean)) {
    return {
      content: clean,
      viewKind: "artifact",
      meta: { artifact: true },
    };
  }
  const hasMeta =
    summary.pending_tasks.length > 0 || Boolean(summary.current_work.trim());
  return {
    content: clean,
    viewKind: "chat",
    meta: hasMeta
      ? {
          pending_tasks: summary.pending_tasks,
          current_work: summary.current_work || undefined,
        }
      : undefined,
  };
}
