"use client";

import { getMinimalToken, wsUrl } from "./client";
import { useMinimalStore } from "./store";
import type { WsFrame } from "./types";

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectMs = 1200;
let intentionalClose = false;

export function connectMinimalWs(token?: string): void {
  const t = token ?? getMinimalToken();
  if (!t) {
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
      useMinimalStore.getState().applyWsFrame(frame);
    } catch {
      /* ignore */
    }
  };

  ws.onerror = () => {
    useMinimalStore.getState().setConnection("error", "websocket error");
  };

  ws.onclose = () => {
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
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  socket?.close();
  socket = null;
}
