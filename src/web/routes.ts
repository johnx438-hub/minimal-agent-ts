/**
 * HTTP route handlers for Web UI (SPEC_WEB_UI W1–W3).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentRuntime } from '../runner.js';
import { loadSession } from '../session.js';
import { buildSessionChatHistory } from '../session-chat-history.js';
import {
  broadcastArmed,
  broadcastLlm,
  dispatchWebCommand,
  llmStatus,
} from '../slash/index.js';
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
    const st = llmStatus(ctx.runtime);
    sendJson(res, 200, {
      ok: true,
      running: ctx.runtime.isRunning(),
      session_id: session?.session_id ?? null,
      model: st.model,
      profile: st.profile,
      armed_workflow: st.armed_workflow,
    });
    return true;
  }

  // ── LLM catalog / switch (W3a) ───────────────────────────────────────
  if (path === '/v1/llm/status' && method === 'GET') {
    sendJson(res, 200, llmStatus(ctx.runtime));
    return true;
  }

  if (path === '/v1/llm/profiles' && method === 'GET') {
    sendJson(res, 200, { profiles: ctx.runtime.listSessionProfileChoices() });
    return true;
  }

  if (path === '/v1/llm/profile' && method === 'POST') {
    if (ctx.runtime.isRunning()) {
      sendJson(res, 409, { error: 'agent_running' });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad_body', detail: String(e) });
      return true;
    }
    if (body.reset === true) {
      ctx.runtime.resetSessionLlmOverride();
      broadcastLlm(ctx.hub, ctx.runtime);
      sendJson(res, 200, { ok: true, ...llmStatus(ctx.runtime) });
      return true;
    }
    const name = String(body.name ?? '').trim();
    if (!name) {
      sendJson(res, 400, { error: 'name_required' });
      return true;
    }
    const r = ctx.runtime.setSessionLlmProfile(name);
    if (r.ok) broadcastLlm(ctx.hub, ctx.runtime);
    sendJson(res, r.ok ? 200 : 400, {
      ok: r.ok,
      message: r.message,
      ...llmStatus(ctx.runtime),
    });
    return true;
  }

  if (path === '/v1/llm/models' && method === 'GET') {
    const asyncMode = url.searchParams.get('async') === '1';
    if (asyncMode) {
      const list = await ctx.runtime.listSessionModelChoicesAsync();
      sendJson(res, 200, {
        models: list.choices,
        source: list.source,
        remoteError: list.remoteError,
      });
      return true;
    }
    sendJson(res, 200, { models: ctx.runtime.listSessionModelChoices() });
    return true;
  }

  if (path === '/v1/llm/model' && method === 'POST') {
    if (ctx.runtime.isRunning()) {
      sendJson(res, 409, { error: 'agent_running' });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad_body', detail: String(e) });
      return true;
    }
    if (body.reset === true) {
      ctx.runtime.resetSessionLlmModel();
      broadcastLlm(ctx.hub, ctx.runtime);
      sendJson(res, 200, { ok: true, ...llmStatus(ctx.runtime) });
      return true;
    }
    const model = String(body.model ?? '').trim();
    if (!model) {
      sendJson(res, 400, { error: 'model_required' });
      return true;
    }
    const r = ctx.runtime.setSessionLlmModel(model);
    if (r.ok) broadcastLlm(ctx.hub, ctx.runtime);
    sendJson(res, r.ok ? 200 : 400, {
      ok: r.ok,
      message: r.message,
      ...llmStatus(ctx.runtime),
    });
    return true;
  }

  // ── Workflows (W3b) ──────────────────────────────────────────────────
  if (path === '/v1/workflows' && method === 'GET') {
    const workflows = ctx.runtime.listWorkflowMeta().map((w) => ({
      name: w.name,
      path: w.path,
      kind: w.kind,
      roles: w.roles,
      share_session: w.shareSession,
    }));
    sendJson(res, 200, {
      workflows,
      armed: ctx.runtime.getArmedWorkflow(),
    });
    return true;
  }

  if (path === '/v1/workflows/arm' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad_body', detail: String(e) });
      return true;
    }
    if (body.name === null || body.path === null || body.arm === false) {
      ctx.runtime.armWorkflow(null);
      broadcastArmed(ctx.hub, ctx.runtime, null);
      sendJson(res, 200, { ok: true, armed: null });
      return true;
    }
    const nameOrPath = String(body.name ?? body.path ?? '').trim();
    if (!nameOrPath) {
      sendJson(res, 400, { error: 'name_or_path_required' });
      return true;
    }
    const resolved = ctx.runtime.resolveWorkflowPath(nameOrPath);
    if (!resolved) {
      sendJson(res, 404, { error: 'workflow_not_found', name: nameOrPath });
      return true;
    }
    ctx.runtime.armWorkflow(resolved);
    broadcastArmed(ctx.hub, ctx.runtime, nameOrPath);
    sendJson(res, 200, { ok: true, armed: resolved, name: nameOrPath });
    return true;
  }

  if (path === '/v1/workflows/armed' && method === 'GET') {
    sendJson(res, 200, { armed: ctx.runtime.getArmedWorkflow() });
    return true;
  }

  // ── Skills (W3b) ─────────────────────────────────────────────────────
  if (path === '/v1/skills' && method === 'GET') {
    sendJson(res, 200, {
      skills: ctx.runtime.listSkills(),
      loaded: ctx.runtime.getLoadedSkills(),
    });
    return true;
  }

  if (path === '/v1/skills/load' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad_body', detail: String(e) });
      return true;
    }
    const name = String(body.name ?? '').trim();
    if (!name) {
      sendJson(res, 400, { error: 'name_required' });
      return true;
    }
    const known = ctx.runtime.listSkills().some((s) => s.name === name);
    if (!known) {
      sendJson(res, 404, { error: 'skill_not_found', name });
      return true;
    }
    ctx.runtime.loadSkill(name);
    ctx.hub.broadcast({ type: 'skills', loaded: ctx.runtime.getLoadedSkills() });
    sendJson(res, 200, {
      ok: true,
      loaded: ctx.runtime.getLoadedSkills(),
      /** Process-scoped until clear — not cleared by switchSession. */
      scope: 'process',
    });
    return true;
  }

  if (path === '/v1/skills/clear' && method === 'POST') {
    ctx.runtime.clearLoadedSkills();
    ctx.hub.broadcast({ type: 'skills', loaded: [] });
    sendJson(res, 200, { ok: true, loaded: [] });
    return true;
  }

  if (path === '/v1/skills/unload' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad_body', detail: String(e) });
      return true;
    }
    const name = String(body.name ?? '').trim();
    if (!name) {
      sendJson(res, 400, { error: 'name_required' });
      return true;
    }
    const ok = ctx.runtime.unloadSkill(name);
    ctx.hub.broadcast({ type: 'skills', loaded: ctx.runtime.getLoadedSkills() });
    sendJson(res, ok ? 200 : 404, {
      ok,
      loaded: ctx.runtime.getLoadedSkills(),
      error: ok ? undefined : 'not_loaded',
    });
    return true;
  }

  // ── Slash command bus (W3c) ──────────────────────────────────────────
  if (path === '/v1/command' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'bad_body', detail: String(e) });
      return true;
    }
    const line = String(body.line ?? body.command ?? '').trim();
    if (!line) {
      sendJson(res, 400, { error: 'line_required' });
      return true;
    }
    const result = dispatchWebCommand(line, ctx.runtime, ctx.hub);

    if (result.action?.type === 'task' || result.action?.type === 'workflow_run') {
      if (ctx.runtime.isRunning()) {
        sendJson(res, 409, { error: 'agent_running', message: result.message });
        return true;
      }
      broadcastRunState(ctx.hub, 'running');
      const runPromise =
        result.action.type === 'workflow_run'
          ? ctx.runtime.runWorkflowTask(result.action.task, result.action.path)
          : ctx.runtime.runTask(result.action.text);
      void runPromise
        .then(() => broadcastRunState(ctx.hub, 'idle'))
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          broadcastRunState(
            ctx.hub,
            detail.includes('Abort') ? 'aborted' : 'error',
            detail,
          );
        });
      sendJson(res, 202, {
        ok: true,
        accepted: true,
        message: result.message,
        data: result.data,
      });
      return true;
    }

    sendJson(res, result.ok ? 200 : 400, {
      ok: result.ok,
      message: result.message,
      data: result.data,
    });
    return true;
  }

  // ── Catalog bundle (optional convenience) ────────────────────────────
  if (path === '/v1/catalog' && method === 'GET') {
    sendJson(res, 200, {
      llm: llmStatus(ctx.runtime),
      profiles: ctx.runtime.listSessionProfileChoices(),
      models: ctx.runtime.listSessionModelChoices(),
      workflows: ctx.runtime.listWorkflowMeta().map((w) => ({
        name: w.name,
        kind: w.kind,
        roles: w.roles,
      })),
      skills: ctx.runtime.listSkills(),
      loaded_skills: ctx.runtime.getLoadedSkills(),
      armed_workflow: ctx.runtime.getArmedWorkflow(),
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

  // GET /v1/sessions/:id/messages — chat history (transcript + in-flight)
  if (
    path.startsWith('/v1/sessions/') &&
    path.endsWith('/messages') &&
    method === 'GET'
  ) {
    const id = decodeURIComponent(
      path.slice('/v1/sessions/'.length, -'/messages'.length),
    );
    if (!id) {
      sendJson(res, 400, { error: 'missing_session_id' });
      return true;
    }
    const session =
      ctx.runtime.session?.session_id === id
        ? ctx.runtime.session
        : loadSession(id);
    if (!session) {
      sendJson(res, 404, { error: 'session_not_found', session_id: id });
      return true;
    }
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw ? Number(limitRaw) : 500;
    const includeTools = url.searchParams.get('tools') !== '0';
    const messages = buildSessionChatHistory(session, {
      limit: Number.isFinite(limit) ? limit : 500,
      includeTools,
    });
    sendJson(res, 200, {
      session_id: session.session_id,
      count: messages.length,
      messages,
    });
    return true;
  }

  // Alias: current session messages
  if (path === '/v1/messages' && method === 'GET') {
    const session = ctx.runtime.session;
    if (!session) {
      sendJson(res, 200, { session_id: null, count: 0, messages: [] });
      return true;
    }
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw ? Number(limitRaw) : 500;
    const includeTools = url.searchParams.get('tools') !== '0';
    const messages = buildSessionChatHistory(session, {
      limit: Number.isFinite(limit) ? limit : 500,
      includeTools,
    });
    sendJson(res, 200, {
      session_id: session.session_id,
      count: messages.length,
      messages,
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
    const session = ctx.runtime.session!;
    const messages = buildSessionChatHistory(session, { limit: 500 });
    sendJson(res, 200, {
      ok: true,
      session_id: session.session_id,
      /** Include history so clients can hydrate chat without a second round-trip. */
      messages,
      message_count: messages.length,
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

    let workflow =
      typeof body.workflow === 'string' && body.workflow.trim()
        ? body.workflow.trim()
        : undefined;
    // TUI parity: armed workflow applies when body omits workflow.
    if (!workflow) {
      const armed = ctx.runtime.getArmedWorkflow();
      if (armed) workflow = armed;
    }

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
