/**
 * Coalesce high-frequency assistant WS deltas into one store update.
 * Same idea as MessageBridge token throttle — cuts React render storm.
 */

import type { WsFrame } from "./types";

const DEFAULT_MS = 48;

type ApplyFn = (frame: WsFrame) => void;

let apply: ApplyFn | null = null;
let buffer = "";
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

function flushBuffer(): void {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!buffer || !apply) {
    buffer = "";
    return;
  }
  const text = buffer;
  buffer = "";
  apply({
    role: "assistant",
    delta: text,
  });
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
}
