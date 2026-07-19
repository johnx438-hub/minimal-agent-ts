import type { ThreadMessageLike } from "@assistant-ui/react";

import {
  attachmentsFromPaths,
  splitAttachmentBlock,
  toThreadAttachments,
} from "./attachment-adapter";
import {
  extractCleanAnswer,
  formatArtifactMarkdown,
  looksLikeArtifact,
  parseAgentSummary,
  projectUserDisplay,
} from "./content-project";
import {
  contentFromWriteArgs,
  diffFromEditArgs,
  formatReadTreePreview,
  formatSpawnDelegationPreview,
  formatWriteCardPreview,
  inferSpawnPresetLabel,
  inferToolName,
  inferToolPath,
  isSpawnDelegationTool,
  restorePreviewNewlines,
  splitToolUiDisplay,
  toolSkin,
} from "./tool-parse";
import { shouldAutoExpandTool, toolDisplayTier } from "./tool-tiers";
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

function toolPartsSemanticallyEqual(
  a: ToolPart[] | undefined,
  b: ToolPart[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.callId !== y.callId ||
      x.toolName !== y.toolName ||
      x.content !== y.content ||
      x.status !== y.status ||
      x.toolExpanded !== y.toolExpanded
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Reuse previous coalesce output object identities when content is unchanged.
 * ExternalStore ThreadMessageConverter caches by WeakMap(input object) — new
 * wrappers every tool call forced full reconvert + layout thrash / scroll jumps.
 */
function reuseCoalesceIdentities(
  next: MinimalMessage[],
  prev: MinimalMessage[] | undefined,
): MinimalMessage[] {
  if (!prev?.length) return next;
  const prevById = new Map(prev.map((m) => [m.id, m]));
  let reused = 0;
  const out = next.map((m) => {
    const p = prevById.get(m.id);
    if (!p || p.role !== m.role) return m;
    if (
      p.content === m.content &&
      p.status === m.status &&
      p.toolsOnly === m.toolsOnly &&
      p.viewKind === m.viewKind &&
      toolPartsSemanticallyEqual(p.toolParts, m.toolParts) &&
      p.meta === m.meta &&
      p.toolExpanded === m.toolExpanded
    ) {
      reused += 1;
      return p;
    }
    return m;
  });
  return reused > 0 ? out : next;
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
    const path =
      inferToolPath(m.content) ||
      inferToolPath(m.argsJson) ||
      undefined;
    const part: ToolPart = {
      toolName: name,
      callId: m.callId || m.id,
      content: m.content ?? "",
      status: m.status === "running" ? "running" : "complete",
      toolExpanded: m.toolExpanded,
      path,
      skin: toolSkin(name),
      argsJson: m.argsJson,
    };

    // Prefer previous assistant even if system notices sit between (vision inject)
    const ai = findAttachAssistantIndex(out);
    if (ai >= 0) {
      const host = out[ai]!;
      host.toolParts = [...(host.toolParts ?? []), part];
      if (part.status === "running") host.status = "running";
    } else {
      // Stable id from tool call — never newMsgId per coalesce pass (remount thrash).
      // Include tool row id so missing callId never collapses two tools into one id.
      const atId = part.callId
        ? `at_${part.callId}`
        : `at_${m.id || newMsgId("t")}`;
      out.push({
        id: atId,
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
  const expanded = applyToolExpandPolicy(merged);
  const reused = reuseCoalesceIdentities(expanded, coalesceCache?.output);
  const result = ensureUniqueMessageIds(reused);
  coalesceCache = { inputs: messages, output: result };
  return result;
}

/** Expand policy aligned with TUI tiers (rich / shell_fold / breadcrumb / spawn). */
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
        toolExpanded: shouldAutoExpandTool({
          toolName: m.toolName,
          content: m.content,
          status: m.status,
          inLatestTurn,
        }),
      };
    }
    if (m.role === "assistant" && m.toolParts?.length) {
      const inLatestTurn = lastUserIdx >= 0 && i > lastUserIdx;
      return {
        ...m,
        toolParts: m.toolParts.map((p) => ({
          ...p,
          toolExpanded: shouldAutoExpandTool({
            toolName: p.toolName,
            content: p.content,
            status: p.status,
            inLatestTurn,
          }),
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

/**
 * Resolve the text that should appear in the tool card body.
 * Prefer write/edit UI display blocks; fall back to args reconstruction.
 */
export function resolveToolDisplayBody(part: ToolPart): {
  body: string;
  kind?: "code" | "diff" | "log" | "mixed";
  path?: string;
  summary?: string;
} {
  const raw = part.content ?? "";
  const split = splitToolUiDisplay(raw);
  const path =
    part.path ||
    inferToolPath(split.summary) ||
    inferToolPath(raw) ||
    inferToolPath(part.argsJson);

  if (split.display?.trim()) {
    return {
      body: split.display.trim(),
      kind: "diff",
      path,
      summary: split.summary,
    };
  }

  const skin = part.skin ?? toolSkin(part.toolName);
  if (skin === "write" || part.toolName === "edit_file") {
    if (part.toolName === "edit_file" || split.kind === "edit") {
      const rebuilt = diffFromEditArgs(part.argsJson);
      if (rebuilt) {
        return { body: rebuilt, kind: "diff", path, summary: split.summary };
      }
    }
    const written = contentFromWriteArgs(part.argsJson);
    if (written) {
      return { body: written, kind: "code", path, summary: split.summary };
    }
  }

  return {
    body: split.summary || raw,
    path,
    summary: split.summary,
  };
}

function formatToolResultBody(part: ToolPart): string {
  const skin = part.skin ?? toolSkin(part.toolName);
  const resolved = resolveToolDisplayBody(part);
  // Live previews used to flatten newlines to literal "\n" — restore for UI.
  let body = restorePreviewNewlines(resolved.body.trim());

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

  // spawn_agent returns full child transcript — never dump into main timeline
  if (isSpawnDelegationTool(part.toolName) || skin === "spawn") {
    return formatSpawnDelegationPreview(
      part.toolName,
      body,
      part.argsJson,
    );
  }

  // Real code/diff body — do not run through the short "ok: wrote" card clip
  if (resolved.kind === "diff" || resolved.kind === "code") {
    return body || "(empty)";
  }

  if (skin === "write") {
    // Status-only fallback when display was stripped (history before bridge fix)
    return (
      formatWriteCardPreview(part.toolName, body, resolved.path ?? part.path)
        .split("\n")
        .slice(1)
        .join("\n")
        .trim() ||
      body ||
      "(empty)"
    );
  }
  if (skin === "read") {
    const tree = formatReadTreePreview(
      part.toolName,
      body,
      resolved.path ?? part.path,
    );
    const lines = tree.split("\n");
    return lines.length > 1 ? lines.slice(1).join("\n") : body || "(empty)";
  }
  if (skin === "shell") {
    // Keep fuller shell body for log pane (card has its own scroll)
    const clip =
      body.length > 12_000 ? `${body.slice(0, 12_000).trim()}…` : body;
    return clip || "(empty)";
  }
  return body || "(empty)";
}

function toolPartToContent(part: ToolPart) {
  const running = part.status === "running";
  const resolved = resolveToolDisplayBody(part);
  const skin = part.skin ?? toolSkin(part.toolName);
  const tier = toolDisplayTier(part.toolName);
  const spawnLabel =
    skin === "spawn" || isSpawnDelegationTool(part.toolName)
      ? inferSpawnPresetLabel(part.content, part.argsJson)
      : undefined;
  const path = resolved.path ?? part.path ?? spawnLabel;
  // Prefer explicit part.toolExpanded; otherwise tier policy
  const wantExpand =
    part.toolExpanded === true
      ? true
      : part.toolExpanded === false
        ? false
        : shouldAutoExpandTool({
            toolName: part.toolName,
            content: part.content,
            status: part.status,
            inLatestTurn: true,
          });
  // Breadcrumb tools: keep trigger-only (empty/minimal body unless expanded/failed)
  const breadcrumbOnly = tier === "breadcrumb" && !wantExpand;
  let argsObj: Record<string, unknown> = {};
  if (part.argsJson) {
    try {
      argsObj = JSON.parse(part.argsJson) as Record<string, unknown>;
    } catch {
      argsObj = {};
    }
  }
  if (path && !argsObj.path) argsObj.path = path;
  const argsText =
    part.argsJson?.trim() ||
    (Object.keys(argsObj).length ? JSON.stringify(argsObj) : "");

  const isSpawn = isSpawnDelegationTool(part.toolName) || skin === "spawn";
  // Compact preview always; full child text only on user expand (capped)
  let fullText: string | undefined;
  if (isSpawn) {
    const rawBody = restorePreviewNewlines(part.content ?? "");
    fullText =
      rawBody.length > 12_000
        ? `${rawBody.slice(0, 12_000)}\n… [UI truncated; full text remains in agent context / job report]`
        : rawBody || undefined;
  }

  return {
    type: "tool-call" as const,
    toolCallId: part.callId,
    toolName: part.toolName,
    args: argsObj,
    argsText,
    result: {
      // Breadcrumb (read/list/grep…): trigger only unless expanded/failed
      preview: breadcrumbOnly ? "" : formatToolResultBody(part),
      skin,
      path,
      kind: resolved.kind,
      fullText,
      _expand: wantExpand,
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
  // Pending / current_work Recap lives in the left session list only —
  // do not append 📋 cards into the message body (avoids history/sync flicker).
  return body;
}

/** Store message → assistant-ui ThreadMessageLike */
export function convertMessage(message: MinimalMessage): ThreadMessageLike {
  if (message.role === "tool") {
    // Fallback if coalesce was skipped
    const name = inferToolName(message.toolName, message.content);
    const path =
      inferToolPath(message.content) ||
      inferToolPath(message.argsJson) ||
      undefined;
    const part: ToolPart = {
      toolName: name,
      callId: message.callId || message.id,
      content: message.content ?? "",
      status: message.status === "running" ? "running" : "complete",
      toolExpanded: message.toolExpanded,
      path,
      skin: toolSkin(name),
      argsJson: message.argsJson,
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

/** True if tool body carries write/edit UI display (or is clearly longer). */
export function toolBodyRichness(content: string | undefined): number {
  const c = content ?? "";
  if (c.includes("[write_display]") || c.includes("[edit_display]")) return 1000 + c.length;
  if (c.includes("\n+") || c.includes("\n-") || c.includes("@@")) return 500 + c.length;
  return c.length;
}

function toolMergeKey(m: MinimalMessage): string | null {
  if (m.role !== "tool") return null;
  const name = m.toolName || inferToolName(undefined, m.content) || "tool";
  const path = inferToolPath(m.content) || inferToolPath(m.argsJson) || "";
  // Match live WS tools to history rows: call_id ≠ action_id, so use summary+path.
  const summary = (m.content ?? "")
    .split("\n[write_display]")[0]
    ?.split("\n[edit_display]")[0]
    ?.split("\n")[0]
    ?.trim()
    .slice(0, 120) ?? "";
  if (path || summary.startsWith("ok:") || summary.startsWith("error:")) {
    return `${name}|${path}|${summary}`;
  }
  if (m.callId) return `id:${m.callId}`;
  return `h:${name}|${summary}`;
}

/**
 * When reloading history after a run, prefer live (or richer) tool bodies so
 * write/edit diffs are not replaced by transcript "ok: wrote…" stubs.
 */
export function preferRicherToolMessages(
  prev: MinimalMessage[],
  incoming: MinimalMessage[],
): MinimalMessage[] {
  if (!prev.length) return incoming;
  const rich = new Map<string, MinimalMessage>();
  for (const m of prev) {
    const k = toolMergeKey(m);
    if (!k) continue;
    const cur = rich.get(k);
    if (!cur || toolBodyRichness(m.content) > toolBodyRichness(cur.content)) {
      rich.set(k, m);
    }
  }
  if (rich.size === 0) return incoming;

  return incoming.map((m) => {
    if (m.role !== "tool") return m;
    const k = toolMergeKey(m);
    if (!k) return m;
    const better = rich.get(k);
    if (!better) return m;
    if (toolBodyRichness(better.content) <= toolBodyRichness(m.content)) {
      return m;
    }
    return {
      ...m,
      content: better.content,
      argsJson: better.argsJson ?? m.argsJson,
      toolName: better.toolName || m.toolName,
      // Keep expand flag from incoming (latest-turn policy)
      toolExpanded: m.toolExpanded || better.toolExpanded,
    };
  });
}

/** Deterministic base id; always suffix with list index for uniqueness. */
function stableHistoryId(
  row: SessionChatMessageDto,
  contentKey: string,
  index: number,
): string {
  if (row.action_id) return `hist_act_${row.action_id}_${index}`;
  const task = row.task_id ?? "t";
  const turn = row.turn ?? 0;
  const role = row.role ?? "x";
  let h = 0;
  const s = contentKey.slice(0, 240);
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
  return `hist_${role}_${task}_${turn}_${(h >>> 0).toString(36)}_${index}`;
}

/**
 * Guarantee unique ids before handing messages to assistant-ui MessageRepository.
 * Duplicate ids throw: "A message with the same id already exists in the parent tree".
 */
export function ensureUniqueMessageIds(
  messages: MinimalMessage[],
): MinimalMessage[] {
  const seen = new Set<string>();
  let changed = false;
  const out = messages.map((m, i) => {
    let id = m.id?.trim() || `m_${i}`;
    if (seen.has(id)) {
      changed = true;
      id = `${id}__${i}`;
      // extreme: still colliding
      while (seen.has(id)) id = `${id}_${seen.size}`;
    }
    seen.add(id);
    return id === m.id ? m : { ...m, id };
  });
  return changed ? out : messages;
}

/**
 * After history reload, keep live React keys when the same logical messages
 * are still present — avoids full-thread remount scroll jumps on post-run sync.
 * Never assigns the same live id to two history rows.
 */
export function preserveLiveMessageIds(
  prev: MinimalMessage[],
  next: MinimalMessage[],
): MinimalMessage[] {
  if (!prev.length || !next.length) return ensureUniqueMessageIds(next);
  const usedPrev = new Set<string>();
  const assigned = new Set<string>();

  const take = (pred: (p: MinimalMessage) => boolean): MinimalMessage | undefined => {
    for (const p of prev) {
      if (usedPrev.has(p.id)) continue;
      if (pred(p)) {
        usedPrev.add(p.id);
        return p;
      }
    }
    return undefined;
  };

  const mapped = next.map((m, i) => {
    let match: MinimalMessage | undefined;
    if (m.role === "tool" && (m.callId || m.id.startsWith("hist_act_"))) {
      const cid = m.callId;
      match = take(
        (p) =>
          p.role === "tool" &&
          ((cid != null && cid !== "" && p.callId === cid) ||
            (cid != null && cid !== "" && p.id === `at_${cid}`) ||
            (p.content === m.content && p.content.length > 0)),
      );
    } else if (
      (m.role === "assistant" || m.role === "user") &&
      m.taskId != null &&
      m.turn != null
    ) {
      match = take(
        (p) =>
          p.role === m.role &&
          p.taskId === m.taskId &&
          p.turn === m.turn &&
          (p.content === m.content ||
            joinContent(p).slice(0, 80) === m.content.slice(0, 80)),
      );
      if (!match) {
        match = take(
          (p) =>
            p.role === m.role && p.taskId === m.taskId && p.turn === m.turn,
        );
      }
    } else if (m.content.trim()) {
      match = take(
        (p) =>
          p.role === m.role &&
          (p.content === m.content || joinContent(p) === m.content),
      );
    }

    let id = match?.id ?? m.id;
    if (assigned.has(id)) {
      // Prefer history's own unique id over double-using a live key
      id = assigned.has(m.id) ? `${m.id}__${i}` : m.id;
      if (assigned.has(id)) id = `${m.id}__${i}_${assigned.size}`;
    }
    assigned.add(id);

    if (!match) {
      return id === m.id ? m : { ...m, id };
    }
    return {
      ...m,
      id,
      toolParts: match.toolParts?.length ? match.toolParts : m.toolParts,
      argsJson: m.argsJson ?? match.argsJson,
      meta: m.meta ?? match.meta,
    };
  });

  return ensureUniqueMessageIds(mapped);
}

export function fromHistoryDto(
  row: SessionChatMessageDto,
  index = 0,
): MinimalMessage {
  const raw = row.content ?? "";
  if (row.role === "assistant") {
    const summary = row.meta ?? parseAgentSummary(raw);
    const clean = row.meta ? raw : extractCleanAnswer(raw);
    const artifact =
      row.view_kind === "artifact" ||
      row.meta?.artifact ||
      looksLikeArtifact(clean);
    return {
      id: stableHistoryId(row, clean, index),
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
      id: stableHistoryId(row, raw, index),
      role: "tool",
      content: raw,
      status: "complete",
      toolName: name,
      callId: row.action_id,
      argsJson: row.args_json,
      turn: row.turn,
      taskId: row.task_id,
      source: row.source,
      viewKind: "tool",
      // Latest-turn expand applied by applyToolExpandPolicy after map
      toolExpanded: false,
    };
  }

  // Server may already project user→system for synthetic job merges;
  // client still unwraps Working directory / system_event as a safety net.
  if (row.role === "system" || row.view_kind === "system_ui") {
    const projected = projectUserDisplay(raw);
    const content = projected.content || raw;
    return {
      id: stableHistoryId(row, content, index),
      role: "system",
      content,
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
  const content = attachments ? displayText : projected.content;

  return {
    id: stableHistoryId({ ...row, role: projected.role }, content, index),
    role: projected.role,
    content,
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
