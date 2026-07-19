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
import {
  GUI_UPLOAD_MAX_BYTES,
  saveGuiUpload,
} from './uploads.js';
import { isWebAuthDisabled } from './auth.js';

import type { WebWorkflowConfirmController } from './workflow-confirm.js';

function capabilitiesSnapshot(runtime: import('../runner.js').AgentRuntime) {
  const gate = runtime.permissionGate;
  return {
    shell: Boolean(runtime.config.allowShell),
    web: Boolean(runtime.config.allowWeb),
    session_grants: {
      shell: gate.hasSessionGrant('shell'),
      web: gate.hasSessionGrant('web'),
    },
    always_grants: {
      shell: gate.hasAlwaysGrant('shell'),
      web: gate.hasAlwaysGrant('web'),
    },
    auth_open: isWebAuthDisabled(),
    /** Local web UI may hot-toggle; still refuse while agent is running. */
    hot_toggle: true,
  };
}

export interface RouteContext {
  runtime: AgentRuntime;
  hub: WsHub;
  cwd: string;
  /** Strict workflow entry gate (TUI overlay parity). */
  workflowConfirm?: WebWorkflowConfirmController;
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

/**
 * One-shot arm: clear runtime + notify Web UI before a user task/workflow run.
 * TUI clears uiState at the same moment; without this, GUI keeps yellow "armed".
 */
function consumeArmedWorkflow(
  runtime: AgentRuntime,
  hub: WsHub,
  explicitWorkflow?: string,
): string | undefined {
  let workflow =
    typeof explicitWorkflow === 'string' && explicitWorkflow.trim()
      ? explicitWorkflow.trim()
      : undefined;
  const previouslyArmed = runtime.getArmedWorkflow();
  if (!workflow && previouslyArmed) {
    workflow = previouslyArmed;
  }
  if (previouslyArmed || workflow) {
    runtime.armWorkflow(null);
    broadcastArmed(hub, runtime, null);
  }
  return workflow;
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
    const caps = capabilitiesSnapshot(ctx.runtime);
    sendJson(res, 200, {
      ok: true,
      running: ctx.runtime.isRunning(),
      session_id: session?.session_id ?? null,
      model: st.model,
      profile: st.profile,
      armed_workflow: st.armed_workflow,
      shell: caps.shell,
      web: caps.web,
      auth_open: caps.auth_open,
    });
    return true;
  }

  // ── Spawn presets (Settings S3, readonly) ────────────────────────────
  if (path === '/v1/spawn/presets' && method === 'GET') {
    const { presets, orphans } = ctx.runtime.listSpawnCatalog();
    sendJson(res, 200, {
      presets: presets.map((p) => {
        const tools = p.tools ?? [];
        const needs_shell = tools.some(
          (t) => t === 'run_shell' || t.startsWith('run_shell'),
        );
        const needs_web = tools.some(
          (t) =>
            t === 'web_fetch' ||
            t === 'web_search' ||
            t.startsWith('web_'),
        );
        return {
          name: p.name,
          description: p.description,
          tools,
          max_turns: p.maxTurns,
          prompt_file: p.promptFile,
          api_profile: p.apiProfile ?? null,
          model: p.model ?? null,
          needs_shell,
          needs_web,
          registered: p.registered,
        };
      }),
      orphans: orphans.map((o) => ({
        path: o.relativePath,
        description: o.description ?? null,
      })),
      invoke_hint:
        'spawn_agent(preset=…) for sync · spawn_background(preset=…) for jobs',
    });
    return true;
  }

  // ── Runtime capabilities (shell / web) ───────────────────────────────
  if (path === '/v1/runtime/capabilities' && method === 'GET') {
    sendJson(res, 200, capabilitiesSnapshot(ctx.runtime));
    return true;
  }

  if (path === '/v1/runtime/capabilities' && method === 'POST') {
    if (ctx.runtime.isRunning()) {
      sendJson(res, 409, { error: 'agent_running' });
      return true;
    }
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
    if (typeof body.shell === 'boolean') {
      ctx.runtime.setAllowShell(body.shell);
    }
    if (typeof body.web === 'boolean') {
      ctx.runtime.setAllowWeb(body.web);
    }
    const caps = capabilitiesSnapshot(ctx.runtime);
    // runtime event also broadcasts; send explicit frame for full grants snapshot
    ctx.hub.broadcast({ type: 'capabilities', ...caps });
    sendJson(res, 200, { ok: true, ...caps });
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

  // ── MCP status (Settings) ────────────────────────────────────────────
  if (path === '/v1/mcp/status' && method === 'GET') {
    const snap = ctx.runtime.getMcpStatus();
    sendJson(res, 200, {
      ok: true,
      ...snap,
      /** Config lives in agent.json; restart web after edits. */
      config_hint: 'agent.json → mcp_servers / mcp_policy · see agent.mcp.example.json',
    });
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
      /** One-shot: next user task only; agent.json sticky may remain after run. */
      scope: 'next_task',
    });
    return true;
  }

  if (path === '/v1/skills/clear' && method === 'POST') {
    ctx.runtime.clearLoadedSkills();
    const loaded = ctx.runtime.getLoadedSkills();
    ctx.hub.broadcast({ type: 'skills', loaded });
    sendJson(res, 200, { ok: true, loaded });
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
      const explicitWf =
        result.action.type === 'workflow_run' ? result.action.path : undefined;
      const workflow = consumeArmedWorkflow(
        ctx.runtime,
        ctx.hub,
        explicitWf,
      );
      broadcastRunState(ctx.hub, 'running');
      const runPromise = workflow
        ? ctx.runtime.runWorkflowTask(
            result.action.type === 'workflow_run'
              ? result.action.task
              : result.action.text,
            workflow,
          )
        : ctx.runtime.runTask(
            result.action.type === 'workflow_run'
              ? result.action.task
              : result.action.text,
          );
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
        // Secondary line: prefer current_work / pending (not raw task title)
        preview: m.last_task_summary,
        last_user_preview: m.last_user_preview,
      })),
      current: ctx.runtime.session?.session_id ?? null,
    });
    return true;
  }

  // POST /v1/sessions — create empty session (TUI /new)
  if (path === '/v1/sessions' && method === 'POST') {
    if (ctx.runtime.isRunning()) {
      sendJson(res, 409, { error: 'agent_running' });
      return true;
    }
    let body: Record<string, unknown> = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      body = {};
    }
    ctx.runtime.newSession();
    const note = typeof body.note === 'string' ? body.note : undefined;
    if (note?.trim() && ctx.runtime.session) {
      ctx.runtime.setSessionNote(ctx.runtime.session.session_id, note);
    }
    const llm = llmStatus(ctx.runtime);
    broadcastLlm(ctx.hub, ctx.runtime);
    sendJson(res, 200, {
      ok: true,
      session_id: ctx.runtime.session?.session_id ?? null,
      messages: [],
      profile: llm.profile ?? null,
      model: llm.model ?? null,
    });
    return true;
  }

  // DELETE /v1/sessions/:id
  if (
    path.startsWith('/v1/sessions/') &&
    method === 'DELETE' &&
    !path.endsWith('/messages') &&
    !path.endsWith('/switch') &&
    !path.endsWith('/note')
  ) {
    const id = decodeURIComponent(path.slice('/v1/sessions/'.length));
    if (!id || id.includes('/')) {
      sendJson(res, 400, { error: 'missing_session_id' });
      return true;
    }
    if (ctx.runtime.isRunning()) {
      sendJson(res, 409, { error: 'agent_running' });
      return true;
    }
    const result = ctx.runtime.deleteSession(id);
    if (!result.ok) {
      sendJson(res, 400, {
        ok: false,
        error: 'delete_failed',
        detail: result.reason,
      });
      return true;
    }
    const llm = llmStatus(ctx.runtime);
    broadcastLlm(ctx.hub, ctx.runtime);
    sendJson(res, 200, {
      ok: true,
      deleted: id,
      session_id: ctx.runtime.session?.session_id ?? null,
      profile: llm.profile ?? null,
      model: llm.model ?? null,
    });
    return true;
  }

  // PATCH/POST /v1/sessions/:id/note  { note: string | null }
  if (
    path.startsWith('/v1/sessions/') &&
    path.endsWith('/note') &&
    (method === 'POST' || method === 'PATCH')
  ) {
    const id = decodeURIComponent(
      path.slice('/v1/sessions/'.length, -'/note'.length),
    );
    if (!id) {
      sendJson(res, 400, { error: 'missing_session_id' });
      return true;
    }
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
    const note =
      body.note === null || body.note === undefined
        ? null
        : String(body.note);
    const ok = ctx.runtime.setSessionNote(id, note);
    if (!ok) {
      sendJson(res, 404, { error: 'session_not_found', session_id: id });
      return true;
    }
    sendJson(res, 200, { ok: true, session_id: id, note: note?.trim() || null });
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
    // Session-scoped llm_override restored by attachSession — push to all UIs (TUI parity)
    const llm = llmStatus(ctx.runtime);
    broadcastLlm(ctx.hub, ctx.runtime);
    sendJson(res, 200, {
      ok: true,
      session_id: session.session_id,
      /** Include history so clients can hydrate chat without a second round-trip. */
      messages,
      message_count: messages.length,
      profile: llm.profile ?? null,
      profile_display: llm.profile_display ?? null,
      model: llm.model ?? null,
      llm_override: ctx.runtime.getSessionLlmOverride(),
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
    // Abort also resolves any pending workflow confirm via AbortSignal
    broadcastRunState(ctx.hub, 'aborted');
    sendJson(res, 200, { ok: true, aborted: true });
    return true;
  }

  /**
   * GUI attachment inbox → workspace/gui-inbox/<session>/…
   * Body: { filename, data_base64, session_id? } or { files: [...] }
   * Returns cwd-relative paths the agent can read_file.
   */
  if (path === '/v1/uploads' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      // base64 ~4/3 of raw; allow a bit over max file size for JSON wrapper
      const raw = await readBody(req, Math.floor(GUI_UPLOAD_MAX_BYTES * 1.5) + 64_000);
      body = raw.trim()
        ? (JSON.parse(raw) as Record<string, unknown>)
        : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('invalid_json');
      }
    } catch (e) {
      sendJson(res, 400, {
        error: 'bad_body',
        detail: e instanceof Error ? e.message : String(e),
      });
      return true;
    }

    type FileIn = { filename?: string; name?: string; data_base64?: string; data?: string };
    const rawList: FileIn[] = Array.isArray(body.files)
      ? (body.files as FileIn[])
      : body.data_base64 || body.data
        ? [body as FileIn]
        : [];

    if (rawList.length === 0) {
      sendJson(res, 400, { error: 'files_required' });
      return true;
    }
    if (rawList.length > 12) {
      sendJson(res, 400, { error: 'too_many_files', max: 12 });
      return true;
    }

    const sessionId =
      (typeof body.session_id === 'string' && body.session_id.trim()) ||
      ctx.runtime.session?.session_id ||
      null;

    const saved: Array<{ path: string; filename: string; bytes: number }> = [];
    try {
      for (const f of rawList) {
        const filename = String(f.filename ?? f.name ?? 'file').trim() || 'file';
        const b64 = String(f.data_base64 ?? f.data ?? '').replace(/^data:[^;]+;base64,/, '');
        if (!b64) {
          sendJson(res, 400, { error: 'data_base64_required', filename });
          return true;
        }
        const bytes = Buffer.from(b64, 'base64');
        if (!bytes.length) {
          sendJson(res, 400, { error: 'empty_file', filename });
          return true;
        }
        const out = saveGuiUpload({
          cwd: ctx.cwd,
          sessionId,
          filename,
          bytes,
        });
        saved.push({
          path: out.relativePath,
          filename,
          bytes: out.bytes,
        });
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const status = detail.startsWith('file_too_large') ? 413 : 400;
      sendJson(res, status, {
        error: 'upload_failed',
        detail,
        max_bytes: GUI_UPLOAD_MAX_BYTES,
      });
      return true;
    }

    sendJson(res, 200, {
      ok: true,
      paths: saved.map((s) => s.path),
      files: saved,
      inbox: 'workspace/gui-inbox',
    });
    return true;
  }

  // GET pending workflow checkpoint (reconnect / poll)
  if (path === '/v1/workflow/confirm' && method === 'GET') {
    const pending = ctx.workflowConfirm?.getPending() ?? null;
    sendJson(res, 200, { pending });
    return true;
  }

  // POST approve/deny — same strict gate as TUI overlay (no always-remember)
  if (path === '/v1/workflow/confirm' && method === 'POST') {
    if (!ctx.workflowConfirm) {
      sendJson(res, 503, { error: 'workflow_confirm_unavailable' });
      return true;
    }
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
    const approved =
      body.approved === true ||
      body.approve === true ||
      body.decision === 'approve' ||
      body.decision === 'yes';
    const denied =
      body.approved === false ||
      body.approve === false ||
      body.decision === 'deny' ||
      body.decision === 'no' ||
      body.decision === 'cancel';
    if (!approved && !denied) {
      sendJson(res, 400, {
        error: 'approved_required',
        detail: 'body.approved must be true or false',
      });
      return true;
    }
    const ok = ctx.workflowConfirm.respond(approved);
    if (!ok) {
      sendJson(res, 409, { error: 'no_pending_confirm' });
      return true;
    }
    sendJson(res, 200, { ok: true, approved });
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

    // TUI parity: pull armed workflow, one-shot clear + WS notify (disarm GUI).
    const workflow = consumeArmedWorkflow(
      ctx.runtime,
      ctx.hub,
      typeof body.workflow === 'string' ? body.workflow : undefined,
    );

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
