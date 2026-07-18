/**
 * Fan-out JSON text frames to connected WebSocket clients.
 */

import type { WebSocket } from 'ws';

export class WsHub {
  private readonly clients = new Set<WebSocket>();

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  size(): number {
    return this.clients.size;
  }

  broadcast(payload: unknown): void {
    if (this.clients.size === 0) return;
    let data: string;
    try {
      data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    } catch {
      return;
    }
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(data);
        } catch {
          this.clients.delete(ws);
        }
      }
    }
  }

  closeAll(): void {
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
