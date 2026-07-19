import type { ThreadMessageLike } from "@assistant-ui/react";

import {
  attachmentsFromPaths,
  splitAttachmentBlock,
  toThreadAttachments,
} from "./attachment-adapter";
import {
  extractCleanAnswer,
  formatArtifactMarkdown,
  formatPendingCardMarkdown,
  looksLikeArtifact,
  parseAgentSummary,
  projectUserDisplay,
} from "./content-project";
import {
  formatReadTreePreview,
  formatWriteCardPreview,
  inferToolName,
  inferToolPath,
  toolSkin,
} from "./tool-parse";
import type {
  MinimalMessage,
  SessionChatMessageDto,
  ToolPart,
} from "./types";

let idSeq = 0;
export function newMsgId(prefix = "m"): string {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq}`;
}

/** Prefer contentChunks (streaming) then content string. */
export function joinContent(m: Pick<MinimalMessage, "content" | "contentChunks">): string {
  if (m.contentChunks?.length) return m.contentChunks.join("");
  return m.content ?? "";
}

/** Cache for delta-only updates: avoid O(messages) coalesce per token. */
let coalesceCache: {
  inputs: MinimalMessage[];
  output: MinimalMessage[];
} | null = null;

function messagesPrefixSame(
  a: MinimalMessage[],
  b: MinimalMessage[],
): boolean {
  if (a.length !== b.length) return false;
  // Prior messages keep object identity under appendAssistantDelta
  for (let i = 0; i < a.length - 1; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Walk back past system notices to find an assistant to attach tools to. */
function findAttachAssistantIndex(out: MinimalMessage[]): number {
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role === "assistant") return i;
    // Real human turn — stop; tools after user start a new toolsOnly bubble
    if (m.role === "user") return -1;
    // system / other: keep walking (vision inject, system_event, …)
  }
  return -1;
}

/** Merge adjacent toolsOnly assistants so history doesn't leave one-card-per-message gaps. */
function mergeAdjacentToolsOnly(messages: MinimalMessage[]): MinimalMessage[] {
  const out: MinimalMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (
      m.role === "assistant" &&
      m.toolsOnly &&
      prev?.role === "assistant" &&
      (prev.toolsOnly || (prev.toolParts?.length && !joinContent(prev).trim()))
    ) {
      prev.toolParts = [...(prev.toolParts ?? []), ...(m.toolParts ?? [])];
      if (m.status === "running") prev.status = "running";
      if (prev.toolsOnly === undefined && !joinContent(prev).trim()) {
        prev.toolsOnly = true;
      }
      continue;
    }
    out.push(m);
  }
  return out;
}

/** Fold consecutive tool rows into the previous assistant (or a tools-only assistant). */
export function coalesceToolsIntoAssistants(
  messages: MinimalMessage[],
): MinimalMessage[] {
  // Fast path: only the last assistant bubble grew (stream delta)
  if (
    coalesceCache &&
    messagesPrefixSame(messages, coalesceCache.inputs) &&
    messages.length > 0
  ) {
    const lastIn = messages[messages.length - 1]!;
    const lastPrev = coalesceCache.inputs[coalesceCache.inputs.length - 1];
    if (lastIn === lastPrev) {
      return coalesceCache.output;
    }
    if (
      lastIn.role === "assistant" &&
      lastPrev?.role === "assistant" &&
      lastIn.id === lastPrev.id &&
      lastIn.toolParts === lastPrev.toolParts &&
      lastPrev.role === "assistant"
    ) {
      const out = coalesceCache.output.slice();
      const lastOut = out[out.length - 1];
      if (lastOut?.role === "assistant" && lastOut.id === lastIn.id) {
        out[out.length - 1] = {
          ...lastOut,
          content: joinContent(lastIn),
          contentChunks: undefined,
          status: lastIn.status,
          meta: lastIn.meta,
          viewKind: lastIn.viewKind,
        };
        coalesceCache = { inputs: messages, output: out };
        return out;
      }
    }
  }

  const out: MinimalMessage[] = [];

  for (const m of messages) {
    if (m.role !== "tool") {
      const content = joinContent(m);
      out.push({
        ...m,
        content,
        contentChunks: undefined,
        toolParts: m.toolParts ? [...m.toolParts] : undefined,
      });
      continue;
    }

    const name = inferToolName(m.toolName, m.content);
    const path = inferToolPath(m.content);
    const part: ToolPart = {
      toolName: name,
      callId: m.callId || m.id,
      content: m.content ?? "",
      status: m.status === "running" ? "running" : "complete",
      toolExpanded: m.toolExpanded,
      path,
      skin: toolSkin(name),
    };

    // Prefer previous assistant even if system notices sit between (vision inject)
    const ai = findAttachAssistantIndex(out);
    if (ai >= 0) {
      const host = out[ai]!;
      host.toolParts = [...(host.toolParts ?? []), part];
      if (part.status === "running") host.status = "running";
    } else {
      out.push({
        id: newMsgId("at"),
        role: "assistant",
        content: "",
        status: part.status === "running" ? "running" : "complete",
        source: m.source,
        viewKind: "chat",
        toolParts: [part],
        toolsOnly: true,
      });
    }
  }

  const merged = mergeAdjacentToolsOnly(out);
  const result = applyToolExpandPolicy(merged);
  coalesceCache = { inputs: messages, output: result };
  return result;
}

/** After history load: tools after last user stay expanded. */
export function applyToolExpandPolicy(
  messages: MinimalMessage[],
): MinimalMessage[] {
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") lastUserIdx = i;
  }

  return messages.map((m, i) => {
    if (m.role === "tool") {
      const inLatestTurn = lastUserIdx >= 0 && i > lastUserIdx;
      return {
        ...m,
        toolExpanded:
          m.status === "running" ? true : inLatestTurn || m.toolExpanded === true,
      };
    }
    if (m.role === "assistant" && m.toolParts?.length) {
      const inLatestTurn = lastUserIdx >= 0 && i > lastUserIdx;
      return {
        ...m,
        toolParts: m.toolParts.map((p) => ({
          ...p,
          toolExpanded:
            p.status === "running"
              ? true
              : inLatestTurn || p.toolExpanded === true,
        })),
      };
    }
    return m;
  });
}

export function collapseToolsExceptLatestTurn(
  messages: MinimalMessage[],
): MinimalMessage[] {
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") lastUserIdx = i;
  }
  return messages.map((m, i) => {
    if (m.role === "tool") {
      const inLatestTurn = lastUserIdx >= 0 && i > lastUserIdx;
      return {
        ...m,
        status: m.status === "running" ? ("complete" as const) : m.status,
        toolExpanded: inLatestTurn,
      };
    }
    if (m.role === "assistant") {
      const inLatestTurn = lastUserIdx >= 0 && i > lastUserIdx;
      const toolParts = m.toolParts?.map((p) => ({
        ...p,
        status:
          p.status === "running" ? ("complete" as const) : p.status,
        toolExpanded: inLatestTurn,
      }));
      return {
        ...m,
        status: m.status === "running" ? ("complete" as const) : m.status,
        toolParts,
      };
    }
    return m;
  });
}

function formatToolResultBody(part: ToolPart): string {
  const skin = part.skin ?? toolSkin(part.toolName);
  // Title already on the trigger — body is content only (avoid double header)
  let body = part.content?.trim() ?? "";

  // Compact vision_attach tool results (JSON marker is agent-facing noise)
  if (
    part.toolName === "vision_attach" ||
    body.startsWith("[vision_attach]")
  ) {
    const note = body
      .replace(/\[vision_attach\]\{[^}]*\}\s*/i, "")
      .replace(/^ok:\s*/i, "")
      .trim();
    const clip =
      note.length > 220 ? `${note.slice(0, 220).trim()}…` : note;
    return clip || "image registered for next model turn";
  }

  if (skin === "write") {
    // write card: path line + clipped body (✓ toolName is in trigger)
    return formatWriteCardPreview(part.toolName, body, part.path)
      .split("\n")
      .slice(1) // drop "✓ toolName"
      .join("\n")
      .trim() || body || "(empty)";
  }
  if (skin === "read") {
    // tree lines only — toolName("path") is trigger title
    const tree = formatReadTreePreview(part.toolName, body, part.path);
    const lines = tree.split("\n");
    return lines.length > 1 ? lines.slice(1).join("\n") : body || "(empty)";
  }
  if (skin === "shell") {
    const clip =
      body.length > 400 ? `${body.slice(0, 400).trim()}…` : body;
    return clip || "(empty)";
  }
  return body || "(empty)";
}

function toolPartToContent(part: ToolPart) {
  const expand =
    part.toolExpanded === true || part.status === "running";
  const running = part.status === "running";
  return {
    type: "tool-call" as const,
    toolCallId: part.callId,
    toolName: part.toolName,
    args: part.path ? { path: part.path } : {},
    argsText: part.path ? JSON.stringify({ path: part.path }) : "",
    result: {
      preview: formatToolResultBody(part),
      skin: part.skin ?? toolSkin(part.toolName),
      path: part.path,
      _expand: expand,
    },
    status: running
      ? ({ type: "running" } as const)
      : ({ type: "complete", reason: "stop" } as const),
  };
}

function buildAssistantDisplayText(message: MinimalMessage): string {
  const body = joinContent(message);
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
    // Fallback if coalesce was skipped
    const name = inferToolName(message.toolName, message.content);
    const path = inferToolPath(message.content);
    const part: ToolPart = {
      toolName: name,
      callId: message.callId || message.id,
      content: message.content ?? "",
      status: message.status === "running" ? "running" : "complete",
      toolExpanded: message.toolExpanded,
      path,
      skin: toolSkin(name),
    };
    return {
      id: message.id,
      role: "assistant",
      content: [toolPartToContent(part) as never],
      status:
        message.status === "running"
          ? { type: "running" }
          : { type: "complete", reason: "stop" },
      metadata: { custom: { toolsOnly: true } },
    };
  }

  if (message.role === "system") {
    // Thread only paints user/assistant — render system notices as a muted assistant card
    const body = (message.content ?? "").trim();
    const md = body
      ? ["> **〔系统〕**", ...body.split("\n").map((l) => `> ${l}`)].join("\n")
      : "> **〔系统〕**";
    return {
      id: message.id,
      role: "assistant",
      content: [{ type: "text", text: md }],
      status: { type: "complete", reason: "stop" },
    };
  }

  if (message.role === "assistant") {
    const parts: unknown[] = [];
    const text = buildAssistantDisplayText(message).trim();
    if (text) {
      parts.push({ type: "text", text: buildAssistantDisplayText(message) });
    }
    for (const tp of message.toolParts ?? []) {
      parts.push(toolPartToContent(tp));
    }
    if (parts.length === 0) {
      parts.push({ type: "text", text: "" });
    }
    const running =
      message.status === "running" ||
      message.toolParts?.some((p) => p.status === "running");
    const toolsOnly =
      Boolean(message.toolsOnly) ||
      (!text && (message.toolParts?.length ?? 0) > 0);
    return {
      id: message.id,
      role: "assistant",
      content: parts as never,
      status: running
        ? { type: "running" }
        : { type: "complete", reason: "stop" },
      metadata: toolsOnly
        ? { custom: { toolsOnly: true } }
        : undefined,
    };
  }

  // User: text bubble + optional attachment chips (UserMessageAttachments)
  const userText = joinContent(message);
  const atts =
    message.attachments?.length
      ? message.attachments
      : attachmentsFromPaths(splitAttachmentBlock(userText).paths);
  const display =
    message.attachments?.length
      ? userText
      : splitAttachmentBlock(userText).displayText || userText;

  return {
    id: message.id,
    role: "user",
    content: [{ type: "text", text: display }],
    attachments: atts.length ? toThreadAttachments(atts) : undefined,
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
    const name = inferToolName(row.tool_name, raw);
    return {
      id: newMsgId("hist"),
      role: "tool",
      content: raw,
      status: "complete",
      toolName: name,
      callId: row.action_id,
      turn: row.turn,
      taskId: row.task_id,
      source: row.source,
      viewKind: "tool",
      toolExpanded: false,
    };
  }

  // Server may already project user→system for synthetic job merges;
  // client still unwraps Working directory / system_event as a safety net.
  if (row.role === "system" || row.view_kind === "system_ui") {
    const projected = projectUserDisplay(raw);
    return {
      id: newMsgId("hist"),
      role: "system",
      content: projected.content || raw,
      status: "complete",
      turn: row.turn,
      taskId: row.task_id,
      source: row.source,
      viewKind: "system_ui",
    };
  }

  const projected = projectUserDisplay(raw);
  // History stores agent text with [attachments] path block — lift to chips
  const { displayText, paths } = splitAttachmentBlock(projected.content);
  const attachments =
    projected.role === "user" && paths.length
      ? attachmentsFromPaths(paths)
      : undefined;

  return {
    id: newMsgId("hist"),
    role: projected.role,
    content: attachments ? displayText : projected.content,
    status: "complete",
    turn: row.turn,
    taskId: row.task_id,
    source: row.source,
    viewKind: projected.viewKind,
    attachments,
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
