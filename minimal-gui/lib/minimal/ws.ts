"use client";

import { getMinimalToken, isMinimalAuthOptional, wsUrl } from "./client";
import {
  configureDeltaBatch,
  enqueueWsFrame,
  flushDeltaBatch,
  resetDeltaBatch,
} from "./delta-batch";
import { useMinimalStore } from "./store";
import type { WsFrame } from "./types";

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectMs = 1200;
let intentionalClose = false;
let batchWired = false;

function ensureDeltaBatch(): void {
  if (batchWired) return;
  batchWired = true;
  configureDeltaBatch((frame) => {
    useMinimalStore.getState().applyWsFrame(frame);
  });
}

export function connectMinimalWs(token?: string): void {
  const t = token ?? getMinimalToken();
  if (!t && !isMinimalAuthOptional()) {
    useMinimalStore.getState().setConnection("error", "missing token");
    return;
  }

  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  intentionalClose = false;
  ensureDeltaBatch();
  useMinimalStore.getState().setConnection("connecting");
  useMinimalStore.getState().setToken(t);

  const url = wsUrl(t);
  const ws = new WebSocket(url);
  socket = ws;

  ws.onopen = () => {
    reconnectMs = 1200;
    useMinimalStore.getState().setConnection("open");
    void useMinimalStore.getState().refreshCatalog();
    void useMinimalStore.getState().loadHistory().catch(() => {
      /* empty session ok */
    });
  };

  ws.onmessage = (ev) => {
    try {
      const frame = JSON.parse(String(ev.data)) as WsFrame;
      // Assistant deltas batched (~50ms); other frames flush pending then apply
      enqueueWsFrame(frame);
    } catch {
      /* ignore */
    }
  };

  ws.onerror = () => {
    useMinimalStore.getState().setConnection("error", "websocket error");
  };

  ws.onclose = () => {
    flushDeltaBatch();
    socket = null;
    useMinimalStore.getState().setConnection("closed");
    if (!intentionalClose) {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        connectMinimalWs(t);
      }, reconnectMs);
      reconnectMs = Math.min(reconnectMs * 1.5, 12_000);
    }
  };
}

export function disconnectMinimalWs(): void {
  intentionalClose = true;
  flushDeltaBatch();
  resetDeltaBatch();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  socket?.close();
  socket = null;
}
