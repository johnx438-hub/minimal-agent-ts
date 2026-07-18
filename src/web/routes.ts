/**
 * HTTP route handlers for Web UI (SPEC_WEB_UI W1).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentRuntime } from '../runner.js';
import { sendJson } from './static.js';
import type { WsHub } from './ws-hub.js';
import type { WebRunStateFrame } from './types.js';
import { snapshotJobs } from './event-bridge.js';

export interface RouteContext {
  runtime: AgentRuntime;
  hub: WsHub;
  cwd: string;
}

function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_json');
  }
  return parsed as Record<string, unknown>;
}

function broadcastRunState(
  hub: WsHub,
  state: WebRunStateFrame['state'],
  detail?: string,
): void {
  const frame: WebRunStateFrame = { type: 'run_state', state, detail };
  hub.broadcast(frame);
}

export async function handleApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  if (path === '/health' && method === 'GET') {
    const session = ctx.runtime.session;
    sendJson(res, 200, {
      ok: true,
      running: ctx.runtime.isRunning(),
      session_id: session?.session_id ?? null,
      model: ctx.runtime.config.model ?? ctx.runtime.config.llm?.model ?? null,
    });
    return true;
  }

  if (path === '/v1/session' && method === 'GET') {
    const s = ctx.runtime.session;
    sendJson(res, 200, {
      session_id: s?.session_id ?? null,
      task_count: s?.tasks?.length ?? 0,
      running: ctx.runtime.isRunning(),
      model: ctx.runtime.config.model ?? ctx.runtime.config.llm?.model ?? null,
    });
    return true;
  }

  if (path === '/v1/sessions' && method === 'GET') {
    const list = ctx.runtime.listSessions().slice(0, 50);
    sendJson(res, 200, {
      sessions: list.map((m) => ({
        session_id: m.session_id,
        updated_at: m.updated_at,
        task_count: m.task_count,
        note: m.note,
      })),
      current: ctx.runtime.session?.session_id ?? null,
    });
    return true;
  }

  if (path.startsWith('/v1/sessions/') && path.endsWith('/switch') && method === 'POST') {
    const id = path.slice('/v1/sessions/'.length, -'/switch'.length);
    if (!id) {
      sendJson(res, 400, { error: 'missing_session_id' });
      return true;
    }
    if (ctx.runtime.isRunning()) {
      sendJson(res, 409, { error: 'agent_running' });
      return true;
    }
    const ok = ctx.runtime.resumeSession(id);
    if (!ok) {
      sendJson(res, 404, { error: 'session_not_found', session_id: id });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      session_id: ctx.runtime.session?.session_id ?? id,
    });
    return true;
  }

  if (path === '/v1/jobs' && method === 'GET') {
    const jobs = snapshotJobs(ctx.runtime);
    sendJson(res, 200, {
      jobs,
      running_count: jobs.filter((j) => j.status === 'running').length,
    });
    return true;
  }

  if (path === '/v1/abort' && method === 'POST') {
    if (!ctx.runtime.isRunning()) {
      sendJson(res, 200, { ok: true, aborted: false, detail: 'not_running' });
      return true;
    }
    ctx.runtime.abort();
    broadcastRunState(ctx.hub, 'aborted');
    sendJson(res, 200, { ok: true, aborted: true });
    return true;
  }

  if (path === '/v1/task' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      sendJson(res, 400, {
        error: 'bad_body',
        detail: e instanceof Error ? e.message : String(e),
      });
      return true;
    }

    const text = String(body.text ?? body.prompt ?? '').trim();
    if (!text) {
      sendJson(res, 400, { error: 'text_required' });
      return true;
    }
    if (ctx.runtime.isRunning()) {
      sendJson(res, 409, { error: 'agent_running' });
      return true;
    }

    const workflow =
      typeof body.workflow === 'string' && body.workflow.trim()
        ? body.workflow.trim()
        : undefined;

    const sessionId =
      typeof body.session_id === 'string' && body.session_id.trim()
        ? body.session_id.trim()
        : undefined;
    if (sessionId && ctx.runtime.session?.session_id !== sessionId) {
      if (!ctx.runtime.resumeSession(sessionId)) {
        sendJson(res, 404, { error: 'session_not_found', session_id: sessionId });
        return true;
      }
    }

    // Fire-and-forget: stream goes over WS via MessageBridge + event-bridge.
    // run_state also comes from RuntimeEvent run_start/run_end (W2).
    broadcastRunState(ctx.hub, 'running');
    const runPromise = workflow
      ? ctx.runtime.runWorkflowTask(text, workflow)
      : ctx.runtime.runTask(text);

    void runPromise
      .then(() => {
        broadcastRunState(ctx.hub, 'idle');
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        if (detail.includes('Abort') || detail === 'Aborted') {
          broadcastRunState(ctx.hub, 'aborted', detail);
        } else {
          broadcastRunState(ctx.hub, 'error', detail);
        }
      });

    sendJson(res, 202, {
      ok: true,
      accepted: true,
      session_id: ctx.runtime.session?.session_id ?? null,
      workflow: workflow ?? null,
    });
    return true;
  }

  return false;
}
