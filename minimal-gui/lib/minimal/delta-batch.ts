/**
 * Coalesce high-frequency assistant WS deltas into one store update.
 * Same idea as MessageBridge token throttle — cuts React render storm.
 *
 * CRITICAL: must preserve session_id / source / source_id on flush.
 * Dropping them made spawn/job child streams look like main-session text
 * (skeleton-reader English interleaved into the parent chat).
 */

import type { WsFrame } from "./types";

const DEFAULT_MS = 48;

type ApplyFn = (frame: WsFrame) => void;

type DeltaMeta = {
  session_id?: string;
  source?: string;
  source_id?: string;
  turn?: number;
  task_id?: string;
};

let apply: ApplyFn | null = null;
let buffer = "";
let bufferMeta: DeltaMeta | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let intervalMs = DEFAULT_MS;

export function configureDeltaBatch(
  applyFrame: ApplyFn,
  opts?: { intervalMs?: number },
): void {
  apply = applyFrame;
  if (opts?.intervalMs != null) {
    intervalMs = Math.max(0, opts.intervalMs);
  }
}

function streamKey(meta: DeltaMeta | null | undefined): string {
  if (!meta) return "";
  return `${meta.source ?? ""}|${meta.session_id ?? ""}|${meta.source_id ?? ""}`;
}

function metaFromFrame(frame: object): DeltaMeta {
  const f = frame as {
    session_id?: string;
    source?: string;
    source_id?: string;
    turn?: number;
    task_id?: string;
  };
  return {
    session_id: f.session_id,
    source: f.source,
    source_id: f.source_id,
    turn: f.turn,
    task_id: f.task_id,
  };
}

function flushBuffer(): void {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!buffer || !apply) {
    buffer = "";
    bufferMeta = null;
    return;
  }
  const text = buffer;
  const meta = bufferMeta;
  buffer = "";
  bufferMeta = null;
  apply({
    role: "assistant",
    delta: text,
    ...(meta ?? {}),
  } as WsFrame);
}

/** Push a frame: assistant deltas are batched; everything else flushes first. */
export function enqueueWsFrame(frame: WsFrame): void {
  if (!apply) return;

  const isAssistantDelta =
    frame &&
    typeof frame === "object" &&
    "role" in frame &&
    (frame as { role?: string }).role === "assistant" &&
    typeof (frame as { delta?: string }).delta === "string" &&
    (frame as { delta: string }).delta.length > 0 &&
    !(frame as { content?: string }).content;

  if (isAssistantDelta) {
    const nextMeta = metaFromFrame(frame as object);
    // Main vs job/spawn (or different child) must not share one buffer
    if (buffer && streamKey(bufferMeta) !== streamKey(nextMeta)) {
      flushBuffer();
    }
    if (!bufferMeta) bufferMeta = nextMeta;
    buffer += (frame as { delta: string }).delta;
    if (intervalMs <= 0) {
      flushBuffer();
      return;
    }
    if (timer == null) {
      timer = setTimeout(() => {
        timer = null;
        flushBuffer();
      }, intervalMs);
    }
    return;
  }

  // Preserve order: deliver pending tokens before control / final / tools
  flushBuffer();
  apply(frame);
}

export function flushDeltaBatch(): void {
  flushBuffer();
}

/** Tests / reconnect */
export function resetDeltaBatch(): void {
  if (timer != null) clearTimeout(timer);
  timer = null;
  buffer = "";
  bufferMeta = null;
}
