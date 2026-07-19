/**
 * HTTP + WebSocket server for browser Web UI (SPEC_WEB_UI).
 */

import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import type { AgentRuntime } from '../runner.js';
import {
  checkToken,
  extractRequestToken,
  resolveWebUiToken,
} from './auth.js';
import { handleApiRoute } from './routes.js';
import {
  applyCors,
  CORS_HEADERS,
  sendJson,
  tryServeStatic,
  safeJoin,
  sendFile,
} from './static.js';
import { llmStatus } from '../slash/index.js';
import { subscribeJobUi } from '../spawn/job-ui-notify.js';
import { attachRuntimeEventBridge, snapshotJobs } from './event-bridge.js';
import type { WebHelloFrame, WebUiHandle, WebUiServerOptions } from './types.js';
import { createWebWorkflowConfirm } from './workflow-confirm.js';
import { WsHub } from './ws-hub.js';
import { createWsMessageSink } from './ws-sink.js';

export interface StartWebUiOptions extends WebUiServerOptions {
  runtime: AgentRuntime;
  cwd: string;
}

function defaultUiDir(cwd: string): string {
  // Prefer shipped public/web-ui; fall back to local workspace scratch.
  const shipped = resolve(cwd, 'public', 'web-ui');
  const local = resolve(cwd, 'workspace', 'web-ui');
  if (existsSync(resolve(shipped, 'index.html'))) return shipped;
  if (existsSync(resolve(local, 'index.html'))) return local;
  return shipped;
}

export async function startWebUi(opts: StartWebUiOptions): Promise<WebUiHandle> {
  const host = opts.host?.trim() || '127.0.0.1';
  const port = opts.port ?? 7788;
  const token = resolveWebUiToken(opts.token);
  const cwd = resolve(opts.cwd);
  const uiDir = resolve(opts.uiDir ?? defaultUiDir(cwd));
  const serveWorkspace = opts.serveWorkspace !== false;
  const workspaceDir = join(cwd, 'workspace');

  const hub = new WsHub();
  const unsubSink = opts.runtime
    .getMessageBridge()
    .addSink(createWsMessageSink(hub));
  const unsubEvents = attachRuntimeEventBridge(opts.runtime, hub);
  // Live job rows without waiting for catalog refresh / listBackgroundJobs
  const unsubJobs = subscribeJobUi((u) => {
    hub.broadcast({
      type: 'job',
      id: u.id,
      status: u.status,
      label: u.label,
      stale: u.stale,
    });
  });
  // Strict workflow entry (same gate as TUI overlay — no always-remember)
  const workflowConfirm = createWebWorkflowConfirm(hub);
  opts.runtime.setWorkflowConfirmFn(workflowConfirm.confirmFn);

  const server: Server = createServer((req, res) => {
    void handleHttp(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    try {
      const hostHdr = req.headers.host ?? `${host}:${port}`;
      const url = new URL(req.url ?? '/', `http://${hostHdr}`);
      if (url.pathname !== '/v1/ws') {
        socket.destroy();
        return;
      }
      const provided = extractRequestToken(req, url);
      if (!checkToken(provided, token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    hub.add(ws);
    const sessions = opts.runtime.listSessions().slice(0, 20).map((m) => ({
      session_id: m.session_id,
      updated_at: m.updated_at,
      task_count: m.task_count,
      note: m.note,
    }));
    const llm = llmStatus(opts.runtime);
    const hello: WebHelloFrame = {
      type: 'hello',
      session_id: opts.runtime.session?.session_id,
      model: (llm.model as string | null) ?? undefined,
      running: opts.runtime.isRunning(),
      sessions,
      jobs: snapshotJobs(opts.runtime),
      profile: (llm.profile as string | null) ?? undefined,
      armed_workflow: (llm.armed_workflow as string | null) ?? undefined,
      loaded_skills: llm.loaded_skills as string[] | undefined,
      workflow_confirm: workflowConfirm.getPending(),
    };
    try {
      ws.send(JSON.stringify(hello));
    } catch {
      /* ignore */
    }

    ws.on('message', (raw) => {
      void handleWsClientMessage(ws, raw, opts.runtime, hub);
    });
  });

  async function handleHttp(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    try {
      const hostHdr = req.headers.host ?? `${host}:${port}`;
      const url = new URL(req.url ?? '/', `http://${hostHdr}`);

      // Cross-origin GUIs (Next :3000 → API :7788) need CORS on every response.
      applyCors(res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      const isHealth = url.pathname === '/health';
      // HTML/CSS/JS shell is public so the page can load; token is enforced on API/WS/workspace.
      const isUiShell =
        url.pathname === '/' ||
        url.pathname.startsWith('/ui') ||
        /\.(html|css|js|svg|ico)$/i.test(url.pathname);

      if (!isHealth && !isUiShell) {
        const provided = extractRequestToken(req, url);
        if (!checkToken(provided, token)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
      }

      if (
        await handleApiRoute(req, res, url, {
          runtime: opts.runtime,
          hub,
          cwd,
          workflowConfirm,
        })
      ) {
        return;
      }

      if (url.pathname.startsWith('/workspace') && serveWorkspace) {
        const sub = url.pathname.slice('/workspace'.length) || '/';
        const filePath = safeJoin(workspaceDir, sub.replace(/^\//, ''));
        if (!filePath) {
          sendJson(res, 403, { error: 'path_escape' });
          return;
        }
        sendFile(res, filePath);
        return;
      }

      // UI: / → uiDir/index.html ; /ui/* → uiDir/*
      let uiPath = url.pathname;
      if (uiPath === '/' || uiPath === '/ui' || uiPath === '/ui/') {
        uiPath = '/index.html';
      } else if (uiPath.startsWith('/ui/')) {
        uiPath = uiPath.slice(3);
      }

      if (tryServeStatic(req, res, uiPath, uiDir)) {
        return;
      }

      sendJson(res, 404, { error: 'not_found', path: url.pathname });
    } catch (err) {
      sendJson(res, 500, {
        error: 'internal',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen());
  });

  const url = `http://${host}:${port}/?token=${encodeURIComponent(token)}`;

  return {
    host,
    port,
    token,
    url,
    async close() {
      unsubSink();
      unsubEvents();
      unsubJobs();
      workflowConfirm.dispose();
      opts.runtime.setWorkflowConfirmFn(undefined);
      hub.closeAll();
      await new Promise<void>((resolveClose, reject) => {
        wss.close(() => {
          server.close((err) => (err ? reject(err) : resolveClose()));
        });
      });
    },
  };
}

async function handleWsClientMessage(
  _ws: WebSocket,
  raw: { toString(): string },
  runtime: AgentRuntime,
  hub: WsHub,
): Promise<void> {
  let msg: { type?: string; text?: string; workflow?: string };
  try {
    msg = JSON.parse(String(raw)) as {
      type?: string;
      text?: string;
      workflow?: string;
    };
  } catch {
    return;
  }

  if (msg.type === 'abort') {
    if (runtime.isRunning()) runtime.abort();
    hub.broadcast({ type: 'run_state', state: 'aborted' });
    return;
  }

  if (msg.type === 'task') {
    const text = String(msg.text ?? '').trim();
    if (!text || runtime.isRunning()) return;
    hub.broadcast({ type: 'run_state', state: 'running' });
    const workflow = msg.workflow?.trim();
    try {
      if (workflow) await runtime.runWorkflowTask(text, workflow);
      else await runtime.runTask(text);
      hub.broadcast({ type: 'run_state', state: 'idle' });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      hub.broadcast({
        type: 'run_state',
        state: detail.includes('Abort') ? 'aborted' : 'error',
        detail,
      });
    }
  }
}

export function printWebUiBanner(handle: WebUiHandle): void {
  console.error('');
  console.error('── Web UI ──────────────────────────────────────');
  console.error(`  ${handle.url}`);
  console.error(`  token: ${handle.token}`);
  console.error('  bind:  local only · open URL above in a browser');
  console.error('────────────────────────────────────────────────');
  console.error('');
}
