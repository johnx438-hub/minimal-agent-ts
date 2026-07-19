"use client";

import { create } from "zustand";

import { getMinimalToken, minimalFetch, rememberToken } from "./client";
import {
  applyToolExpandPolicy,
  collapseToolsExceptLatestTurn,
  fromHistoryDto,
  joinContent,
  newMsgId,
  projectAssistantFinal,
} from "./convert";
import { inferToolName } from "./tool-parse";
import type {
  ActiveSpawn,
  ConnectionState,
  JobMeta,
  MinimalMessage,
  ModelMeta,
  ProfileMeta,
  SessionChatMessageDto,
  SessionMeta,
  RuntimeCapabilities,
  SkillMeta,
  WorkflowConfirmPending,
  WorkflowMeta,
  WsFrame,
} from "./types";

export interface MinimalStore {
  token: string;
  connection: ConnectionState;
  lastError?: string;

  messages: MinimalMessage[];
  isRunning: boolean;

  sessionId: string | null;
  sessions: SessionMeta[];

  profile: string | null;
  model: string | null;
  profiles: ProfileMeta[];
  models: ModelMeta[];

  workflows: WorkflowMeta[];
  armedWorkflow: string | null;
  skills: SkillMeta[];
  loadedSkills: string[];
  jobs: JobMeta[];

  workflowSteps: Array<{
    id: string;
    phase: string;
    role: string;
    nodeId?: string;
    status?: string;
  }>;

  /** Strict workflow entry gate (TUI overlay parity). */
  workflowConfirm: WorkflowConfirmPending | null;
  workflowConfirmBusy: boolean;

  /** Sync spawn_agent activity (child stream not mixed into main bubbles). */
  activeSpawns: ActiveSpawn[];

  /** Shell / web process flags (Settings + optional WS sync). */
  capabilities: RuntimeCapabilities | null;

  setToken: (token: string) => void;
  setConnection: (c: ConnectionState, err?: string) => void;
  setMessages: (messages: MinimalMessage[]) => void;
  hydrateHistory: (rows: SessionChatMessageDto[]) => void;
  applyWsFrame: (frame: WsFrame) => void;

  sendTask: (
    text: string,
    opts?: {
      /** User-visible bubble (defaults to text with attachment block stripped) */
      displayContent?: string;
      attachments?: import("./types").MessageAttachment[];
    },
  ) => Promise<void>;
  /** Slash line e.g. /profile list — POST /v1/command */
  sendCommand: (line: string) => Promise<void>;
  abort: () => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  createSession: (note?: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  setSessionNote: (id: string, note: string) => Promise<void>;
  armWorkflow: (name: string | null) => Promise<void>;
  setProfile: (name: string) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  loadSkill: (name: string) => Promise<void>;
  clearLoadedSkills: () => Promise<void>;
  clearWorkflowSteps: () => void;
  refreshCatalog: () => Promise<void>;
  loadHistory: (sessionId?: string) => Promise<void>;
  respondWorkflowConfirm: (approved: boolean) => Promise<void>;
  refreshCapabilities: () => Promise<void>;
  setCapability: (
    kind: "shell" | "web",
    on: boolean,
  ) => Promise<{ ok: boolean; message?: string }>;
}

function appendAssistantDelta(
  messages: MinimalMessage[],
  delta: string,
): MinimalMessage[] {
  const next = [...messages];
  const last = next[next.length - 1];
  if (last?.role === "assistant" && last.status === "running") {
    // Append chunk without mutating prior state snapshots (new array each time).
    // join at display time — avoids O(n²) full-string copy of the answer body.
    const chunks = last.contentChunks?.length
      ? last.contentChunks.concat(delta)
      : last.content
        ? [last.content, delta]
        : [delta];
    next[next.length - 1] = {
      ...last,
      contentChunks: chunks,
      content: "",
    };
    return next;
  }
  next.push({
    id: newMsgId("a"),
    role: "assistant",
    content: "",
    contentChunks: [delta],
    status: "running",
    source: "live",
  });
  return next;
}

/**
 * Close a streaming assistant, or append a non-stream final.
 *
 * Critical: run_state idle/aborted also calls this with no content. Must NOT
 * re-append when the WS final already completed the bubble — that was the
 * classic “assistant message appears twice” bug (K3 HTML + Route A store).
 */
function finalizeAssistant(
  messages: MinimalMessage[],
  content?: string,
): MinimalMessage[] {
  const next = [...messages];
  const last = next[next.length - 1];
  const hasExplicit =
    content != null && content !== "";

  // Still streaming → seal the same bubble (optional replace with full final text)
  if (last?.role === "assistant" && last.status === "running") {
    const live = joinContent(last);
    const projected = hasExplicit
      ? projectAssistantFinal(content!)
      : projectAssistantFinal(live);
    next[next.length - 1] = {
      ...last,
      content: projected.content,
      contentChunks: undefined,
      meta: projected.meta ?? last.meta,
      viewKind: projected.viewKind ?? last.viewKind,
      status: "complete",
    };
    return next;
  }

  // run_end / collapse path with no new body: do not invent a second message
  if (!hasExplicit) return next;

  const projected = projectAssistantFinal(content!);
  if (!projected.content) return next;

  // Same final delivered twice (or final after already-complete bubble)
  if (
    last?.role === "assistant" &&
    last.content === projected.content
  ) {
    next[next.length - 1] = {
      ...last,
      meta: projected.meta ?? last.meta,
      viewKind: projected.viewKind ?? last.viewKind,
      status: "complete",
    };
    return next;
  }

  next.push({
    id: newMsgId("a"),
    role: "assistant",
    content: projected.content,
    meta: projected.meta,
    viewKind: projected.viewKind,
    status: "complete",
    source: "live",
  });
  return next;
}

export const useMinimalStore = create<MinimalStore>((set, get) => ({
  token: "",
  connection: "idle",
  messages: [],
  isRunning: false,
  sessionId: null,
  sessions: [],
  profile: null,
  model: null,
  profiles: [],
  models: [],
  workflows: [],
  armedWorkflow: null,
  skills: [],
  loadedSkills: [],
  jobs: [],
  workflowSteps: [],
  workflowConfirm: null,
  workflowConfirmBusy: false,
  activeSpawns: [],
  capabilities: null,

  setToken(token) {
    rememberToken(token);
    set({ token });
  },

  setConnection(connection, lastError) {
    set({ connection, lastError });
  },

  setMessages(messages) {
    set({ messages });
  },

  hydrateHistory(rows) {
    set({
      messages: applyToolExpandPolicy(rows.map(fromHistoryDto)),
    });
  },

  applyWsFrame(frame) {
    // Control frames with type
    if (frame && typeof frame === "object" && "type" in frame && frame.type) {
      switch (frame.type) {
        case "hello": {
          const wc = frame.workflow_confirm;
          set({
            sessionId: frame.session_id ?? get().sessionId,
            model: frame.model ?? get().model,
            profile: frame.profile ?? get().profile,
            isRunning: !!frame.running,
            sessions: frame.sessions ?? get().sessions,
            armedWorkflow:
              frame.armed_workflow !== undefined
                ? frame.armed_workflow
                : get().armedWorkflow,
            loadedSkills: frame.loaded_skills ?? get().loadedSkills,
            jobs: frame.jobs
              ? frame.jobs.map((j) => ({
                  id: j.id,
                  status: j.status,
                  label: j.label,
                }))
              : get().jobs,
            workflowConfirm:
              wc && (wc.status === "pending" || !wc.status)
                ? {
                    workflow: wc.workflow,
                    path: wc.path,
                    needs_shell: wc.needs_shell,
                    needs_web: wc.needs_web,
                    roles: wc.roles,
                    summary: wc.summary,
                  }
                : get().workflowConfirm,
          });
          return;
        }
        case "run_state": {
          const running = frame.state === "running";
          const ending =
            frame.state === "idle" ||
            frame.state === "aborted" ||
            frame.state === "error";
          set((s) => {
            let messages = s.messages;
            if (ending) {
              messages = collapseToolsExceptLatestTurn(
                finalizeAssistant(messages),
              );
            }
            return {
              isRunning: running,
              sessionId: frame.session_id ?? s.sessionId,
              model: frame.model ?? s.model,
              messages,
              // Gate only lives while a workflow is waiting — clear on terminal states
              workflowConfirm: ending ? null : s.workflowConfirm,
              workflowConfirmBusy: ending ? false : s.workflowConfirmBusy,
              activeSpawns: ending ? [] : s.activeSpawns,
              lastError:
                frame.state === "error" ? frame.detail : s.lastError,
            };
          });
          if (frame.state === "error" && frame.detail) {
            set((s) => ({
              messages: [
                ...s.messages,
                {
                  id: newMsgId("sys"),
                  role: "system",
                  content: `⚠ ${frame.detail}`,
                  status: "complete",
                  source: "live",
                  viewKind: "system_ui",
                },
              ],
            }));
          }
          return;
        }
        case "job": {
          set((s) => {
            const jobs = [...s.jobs];
            const i = jobs.findIndex((j) => j.id === frame.id);
            const row = {
              id: frame.id,
              status: frame.status,
              label: frame.label,
            };
            if (i >= 0) jobs[i] = row;
            else jobs.unshift(row);
            return { jobs };
          });
          return;
        }
        case "workflow_step": {
          set((s) => ({
            workflowSteps: [
              ...s.workflowSteps.map((st) =>
                st.status === "running" ? { ...st, status: "done" } : st,
              ),
              {
                id: newMsgId("wf"),
                phase: frame.phase,
                role: frame.role,
                nodeId: frame.nodeId,
                status: frame.status || "running",
              },
            ],
          }));
          return;
        }
        case "workflow_armed": {
          set({
            armedWorkflow: frame.name ?? frame.path,
          });
          return;
        }
        case "workflow_handback": {
          set((s) => ({
            messages: [
              ...s.messages,
              {
                id: newMsgId("sys"),
                role: "system",
                content: `handback · ${frame.workflow} · ${frame.reason}\n${frame.detail || ""}`,
                status: "complete",
                source: "live",
              },
            ],
            isRunning: false,
          }));
          return;
        }
        case "workflow_confirm": {
          if (frame.status === "pending") {
            set({
              workflowConfirm: {
                workflow: frame.workflow,
                path: frame.path,
                needs_shell: frame.needs_shell,
                needs_web: frame.needs_web,
                roles: frame.roles,
                summary: frame.summary,
              },
              workflowConfirmBusy: false,
            });
          } else {
            set({
              workflowConfirm: null,
              workflowConfirmBusy: false,
            });
          }
          return;
        }
        case "spawn": {
          if (frame.phase === "start") {
            set((s) => {
              const id = frame.preset;
              const rest = s.activeSpawns.filter((x) => x.id !== id);
              return {
                activeSpawns: [
                  {
                    id,
                    preset: frame.preset,
                    status: "running" as const,
                    preview: "",
                  },
                  ...rest,
                ].slice(0, 6),
              };
            });
          } else {
            set((s) => ({
              activeSpawns: s.activeSpawns.map((x) =>
                x.preset === frame.preset || x.id === frame.preset
                  ? {
                      ...x,
                      status: frame.ok === false ? "failed" : "done",
                      preview: frame.detail
                        ? frame.detail.slice(0, 160)
                        : x.preview,
                    }
                  : x,
              ),
            }));
            // Drop finished spawns shortly so banner does not stick forever
            setTimeout(() => {
              useMinimalStore.setState((s) => ({
                activeSpawns: s.activeSpawns.filter(
                  (x) => x.status === "running",
                ),
              }));
            }, 4000);
          }
          return;
        }
        case "llm": {
          // Session switch /profile /model — keep dropdown active flags in sync
          const nextProfile = frame.profile ?? get().profile;
          const nextModel = frame.model ?? get().model;
          set((s) => ({
            profile: nextProfile,
            model: nextModel,
            armedWorkflow:
              frame.armed_workflow !== undefined
                ? frame.armed_workflow
                : s.armedWorkflow,
            profiles: s.profiles.map((p) => ({
              ...p,
              active: p.name === nextProfile,
            })),
            models: s.models.map((m) => ({
              ...m,
              active: m.model === nextModel,
            })),
          }));
          return;
        }
        case "skills": {
          set({ loadedSkills: frame.loaded ?? [] });
          return;
        }
        case "capabilities": {
          set({
            capabilities: {
              shell: frame.shell,
              web: frame.web,
              session_grants: frame.session_grants,
              always_grants: frame.always_grants,
              auth_open: frame.auth_open,
              hot_toggle: frame.hot_toggle ?? true,
            },
          });
          return;
        }
        default:
          break;
      }
    }

    // SessionMessage (no discriminant `type`)
    if (!frame || typeof frame !== "object" || !("role" in frame)) return;
    const sm = frame as {
      role?: string;
      session_id?: string;
      source?: string;
      source_id?: string;
      delta?: string;
      content?: string;
      tool_name?: string;
      call_id?: string;
    };
    const role = sm.role;
    if (!role || role === "user") {
      // Local onNew already appended user; skip bridge echo to avoid duplicates
      return;
    }

    // Child spawn/job agents use a different session_id on the same WS hub.
    // Keep them out of main bubbles (avoid TUI-era main/child text merge),
    // but feed activeSpawns so the UI is not silent during sync spawn_agent.
    const frameSession = sm.session_id;
    const currentSession = get().sessionId;
    const bridgeSource = sm.source;
    const isChildAgentStream =
      bridgeSource === "job" ||
      bridgeSource === "spawn" ||
      (Boolean(frameSession) &&
        Boolean(currentSession) &&
        frameSession !== currentSession);

    // Settlement notices are tagged source=job but use parent session_id —
    // still allow system_notice onto the main timeline.
    if (isChildAgentStream && role !== "system_notice") {
      const spawnKey =
        sm.source_id ||
        frameSession ||
        (bridgeSource === "spawn" ? "spawn" : "job");
      const presetLabel =
        bridgeSource === "spawn"
          ? sm.source_id || "spawn"
          : sm.source_id || spawnKey;

      // Background jobs: only touch jobs panel (never stream previews into the
      // top strip — multi-job preview thrash was causing layout / scroll shake).
      if (bridgeSource === "job" && sm.source_id) {
        if (role === "tool" || (role === "assistant" && sm.content)) {
          set((s) => {
            const jobs = [...s.jobs];
            const id = sm.source_id!;
            const i = jobs.findIndex((j) => j.id === id);
            const tool =
              role === "tool"
                ? inferToolName(sm.tool_name, sm.content)
                : undefined;
            const row = {
              id,
              status: "running" as const,
              label:
                jobs[i]?.label ||
                tool ||
                id.slice(0, 14),
            };
            if (i >= 0) {
              jobs[i] = {
                ...jobs[i]!,
                status: "running",
                // keep stable label after first set
                label: jobs[i]!.label || row.label,
              };
            } else jobs.unshift(row);
            return { jobs: jobs.slice(0, 20) };
          });
        }
        return;
      }

      // Sync spawn: strip shows name + last tool only — ignore token deltas
      if (role === "assistant" && sm.delta) {
        return;
      }

      set((s) => {
        const list = [...s.activeSpawns];
        let row = list.find(
          (x) => x.id === spawnKey || x.preset === presetLabel,
        );
        if (!row) {
          row = {
            id: spawnKey,
            preset: presetLabel,
            status: "running",
            preview: "",
          };
          list.unshift(row);
        }
        const idx = list.findIndex((x) => x.id === row!.id);
        let lastTool = row.lastTool;
        if (role === "tool") {
          lastTool = inferToolName(sm.tool_name, sm.content);
        }
        // Skip update if nothing meaningful changed (fewer re-renders)
        if (
          row.status === "running" &&
          row.lastTool === lastTool &&
          row.preset === (row.preset || presetLabel)
        ) {
          return s;
        }
        list[idx] = {
          ...row,
          status: "running",
          lastTool,
          preset: row.preset || presetLabel,
          // keep preview empty — top bar is compact only
          preview: "",
        };
        return { activeSpawns: list.slice(0, 6) };
      });
      return;
    }

    const delta = sm.delta;
    const content = sm.content;
    const toolName = sm.tool_name;
    const callId = sm.call_id;

    if (role === "assistant") {
      if (delta) {
        set((s) => ({ messages: appendAssistantDelta(s.messages, delta) }));
        return;
      }
      if (content != null && content !== "") {
        set((s) => ({
          messages: finalizeAssistant(s.messages, content),
        }));
      }
      return;
    }

    if (role === "tool") {
      // Live tools open while run is active; real name via inferToolName.
      const name = inferToolName(toolName, content);
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: newMsgId("t"),
            role: "tool" as const,
            content: content ?? "",
            toolName: name,
            callId,
            status: s.isRunning ? ("running" as const) : ("complete" as const),
            source: "live" as const,
            viewKind: "tool" as const,
            toolExpanded: true,
          },
        ],
      }));
      return;
    }

    if (role === "system_notice" && content) {
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: newMsgId("sys"),
            role: "system",
            content,
            status: "complete",
            source: "live",
            viewKind: "system_ui",
          },
        ],
      }));
    }
  },

  async sendTask(text, opts) {
    const trimmed = text.trim();
    if (!trimmed && !opts?.attachments?.length) return;
    // Slash commands never go through the agent task path
    if (trimmed.startsWith("/")) {
      await get().sendCommand(trimmed);
      return;
    }
    // Bubble: clean user text + chips; agent still receives full path block in `trimmed`
    const stripped = trimmed
      .replace(
        /\n*\n?\[attachments[^\]]*\]\s*\n((?:[ \t]*-[ \t]*\S[^\n]*\n?)*)\s*$/i,
        "",
      )
      .trim();
    const displayContent =
      opts?.displayContent ??
      (stripped || (opts?.attachments?.length ? "" : trimmed));

    const userMsg: MinimalMessage = {
      id: newMsgId("u"),
      role: "user",
      content: displayContent || (opts?.attachments?.length ? "（附件）" : trimmed),
      status: "complete",
      source: "live",
      attachments: opts?.attachments,
    };
    set((s) => ({
      messages: [...s.messages, userMsg],
      isRunning: true,
      lastError: undefined,
      workflowSteps: s.armedWorkflow ? [] : s.workflowSteps,
    }));

    try {
      const body: Record<string, string> = { text: trimmed };
      const { sessionId } = get();
      if (sessionId) body.session_id = sessionId;
      const res = await minimalFetch<{
        session_id?: string;
      }>("/v1/task", {
        method: "POST",
        body: JSON.stringify(body),
        token: get().token || getMinimalToken(),
      });
      if (res.session_id) set({ sessionId: res.session_id });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({
        isRunning: false,
        lastError: message,
        messages: [
          ...s.messages,
          {
            id: newMsgId("sys"),
            role: "system",
            content: `发送失败: ${message}`,
            status: "complete",
            source: "live",
          },
        ],
      }));
    }
  },

  async sendCommand(line: string) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) {
      await get().sendTask(trimmed);
      return;
    }

    // Show the slash line in the thread as a system/user echo
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: newMsgId("u"),
          role: "user",
          content: trimmed,
          status: "complete",
          source: "live",
        },
      ],
      lastError: undefined,
    }));

    try {
      const res = await minimalFetch<{
        ok?: boolean;
        message?: string;
        accepted?: boolean;
        data?: unknown;
      }>("/v1/command", {
        method: "POST",
        body: JSON.stringify({ line: trimmed }),
        token: get().token || getMinimalToken(),
      });

      const reply =
        res.message?.trim() ||
        (res.ok === false ? "command failed" : "ok");

      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: newMsgId("sys"),
            role: "system",
            content: reply,
            status: "complete",
            source: "live",
          },
        ],
        // Command may start a long run (/workflow run …) — 202 accepted
        isRunning: res.accepted === true ? true : s.isRunning,
        workflowSteps:
          res.accepted === true && /workflow/i.test(trimmed)
            ? []
            : s.workflowSteps,
      }));

      // Refresh catalog after profile/model/workflow/skills side effects
      void get().refreshCatalog();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set((s) => ({
        lastError: message,
        isRunning: false,
        messages: [
          ...s.messages,
          {
            id: newMsgId("sys"),
            role: "system",
            content: `命令失败: ${message}`,
            status: "complete",
            source: "live",
          },
        ],
      }));
    }
  },

  async abort() {
    try {
      await minimalFetch("/v1/abort", {
        method: "POST",
        body: "{}",
        token: get().token || getMinimalToken(),
      });
      set({ workflowConfirm: null, workflowConfirmBusy: false });
    } catch (e) {
      set({
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  async respondWorkflowConfirm(approved: boolean) {
    if (get().workflowConfirmBusy) return;
    set({ workflowConfirmBusy: true });
    try {
      await minimalFetch("/v1/workflow/confirm", {
        method: "POST",
        body: JSON.stringify({ approved }),
        token: get().token || getMinimalToken(),
      });
      // WS will clear pending; optimistically dismiss modal
      if (!approved) {
        set({ workflowConfirm: null, workflowConfirmBusy: false });
      } else {
        set({ workflowConfirm: null, workflowConfirmBusy: false });
      }
    } catch (e) {
      set({
        workflowConfirmBusy: false,
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  async switchSession(id: string) {
    if (get().isRunning) {
      set({ lastError: "agent is running — abort first" });
      return;
    }
    if (id === get().sessionId && get().messages.length > 0) return;
    try {
      const res = await minimalFetch<{
        session_id: string;
        messages?: SessionChatMessageDto[];
        profile?: string | null;
        model?: string | null;
        llm_override?: {
          profileName?: string;
          model?: string;
          reasoningLevel?: string;
        };
      }>(`/v1/sessions/${encodeURIComponent(id)}/switch`, {
        method: "POST",
        body: "{}",
        token: get().token || getMinimalToken(),
      });
      // Profile/model follow the session file (llm_override), same as TUI resume
      const nextProfile =
        res.profile ??
        res.llm_override?.profileName ??
        get().profile;
      const nextModel =
        res.model ?? res.llm_override?.model ?? get().model;
      set({
        sessionId: res.session_id || id,
        messages: applyToolExpandPolicy(
          (res.messages ?? []).map(fromHistoryDto),
        ),
        workflowSteps: [],
        lastError: undefined,
        profile: nextProfile ?? null,
        model: nextModel ?? null,
        sessions: get().sessions.map((s) =>
          s.session_id === (res.session_id || id) ? { ...s } : s,
        ),
      });
      if (!res.messages?.length) {
        await get().loadHistory(res.session_id || id);
      }
      // Refresh profile/model dropdowns so active flags match this session
      await get().refreshCatalog();
    } catch (e) {
      set({
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  async createSession(note?: string) {
    if (get().isRunning) {
      set({ lastError: "agent is running — abort first" });
      return;
    }
    try {
      const res = await minimalFetch<{
        session_id?: string;
        profile?: string | null;
        model?: string | null;
      }>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify(note?.trim() ? { note: note.trim() } : {}),
        token: get().token || getMinimalToken(),
      });
      set({
        sessionId: res.session_id ?? null,
        messages: [],
        workflowSteps: [],
        profile: res.profile ?? get().profile,
        model: res.model ?? get().model,
        lastError: undefined,
      });
      await get().refreshCatalog();
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  async deleteSession(id: string) {
    if (get().isRunning) {
      set({ lastError: "agent is running — abort first" });
      return;
    }
    try {
      const res = await minimalFetch<{
        ok?: boolean;
        session_id?: string | null;
        profile?: string | null;
        model?: string | null;
      }>(`/v1/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        token: get().token || getMinimalToken(),
      });
      const wasCurrent = id === get().sessionId;
      set({
        sessions: get().sessions.filter((s) => s.session_id !== id),
        lastError: undefined,
      });
      if (wasCurrent) {
        set({
          sessionId: res.session_id ?? null,
          messages: [],
          workflowSteps: [],
          profile: res.profile ?? get().profile,
          model: res.model ?? get().model,
        });
        if (res.session_id) {
          await get().loadHistory(res.session_id).catch(() => {
            set({ messages: [] });
          });
        }
      }
      await get().refreshCatalog();
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  async setSessionNote(id: string, note: string) {
    try {
      const res = await minimalFetch<{ note?: string | null }>(
        `/v1/sessions/${encodeURIComponent(id)}/note`,
        {
          method: "POST",
          body: JSON.stringify({ note: note.trim() || null }),
          token: get().token || getMinimalToken(),
        },
      );
      set({
        sessions: get().sessions.map((s) =>
          s.session_id === id
            ? { ...s, note: res.note ?? undefined }
            : s,
        ),
        lastError: undefined,
      });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  async armWorkflow(name: string | null) {
    const res = await minimalFetch<{
      armed?: string | null;
      name?: string;
    }>("/v1/workflows/arm", {
      method: "POST",
      body: JSON.stringify({ name }),
      token: get().token || getMinimalToken(),
    });
    set({
      armedWorkflow: name === null ? null : res.name || name,
      workflowSteps: name === null ? get().workflowSteps : [],
    });
  },

  clearWorkflowSteps() {
    set({ workflowSteps: [] });
  },

  async setProfile(name: string) {
    if (get().isRunning) {
      set({ lastError: "cannot change profile while running" });
      return;
    }
    try {
      const res = await minimalFetch<{
        ok?: boolean;
        message?: string;
        profile?: string;
        model?: string;
      }>("/v1/llm/profile", {
        method: "POST",
        body: JSON.stringify({ name }),
        token: get().token || getMinimalToken(),
      });
      set({
        profile: res.profile ?? name,
        model: res.model ?? get().model,
        lastError: undefined,
      });
      await get().refreshCatalog();
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
      await get().refreshCatalog();
    }
  },

  async setModel(model: string) {
    if (get().isRunning) {
      set({ lastError: "cannot change model while running" });
      return;
    }
    try {
      const res = await minimalFetch<{
        ok?: boolean;
        message?: string;
        model?: string;
      }>("/v1/llm/model", {
        method: "POST",
        body: JSON.stringify({ model }),
        token: get().token || getMinimalToken(),
      });
      set({
        model: res.model ?? model,
        lastError: undefined,
      });
      await get().refreshCatalog();
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
      await get().refreshCatalog();
    }
  },

  async loadSkill(name: string) {
    try {
      const res = await minimalFetch<{ loaded?: string[] }>("/v1/skills/load", {
        method: "POST",
        body: JSON.stringify({ name }),
        token: get().token || getMinimalToken(),
      });
      set({
        loadedSkills: res.loaded ?? [...get().loadedSkills, name],
        lastError: undefined,
      });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  async clearLoadedSkills() {
    try {
      await minimalFetch("/v1/skills/clear", {
        method: "POST",
        body: "{}",
        token: get().token || getMinimalToken(),
      });
      set({ loadedSkills: [], lastError: undefined });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  async refreshCatalog() {
    const token = get().token || getMinimalToken();
    try {
      const cat = await minimalFetch<{
        profiles?: ProfileMeta[];
        models?: ModelMeta[];
        workflows?: WorkflowMeta[];
        skills?: SkillMeta[];
        loaded_skills?: string[];
        llm?: {
          profile?: string;
          model?: string;
          armed_workflow?: string | null;
        };
        armed_workflow?: string | null;
      }>("/v1/catalog", { token });
      set({
        profiles: cat.profiles ?? [],
        models: cat.models ?? [],
        workflows: cat.workflows ?? [],
        skills: cat.skills ?? [],
        loadedSkills: cat.loaded_skills ?? [],
        profile: cat.llm?.profile ?? get().profile,
        model: cat.llm?.model ?? get().model,
        armedWorkflow:
          cat.llm?.armed_workflow ??
          cat.armed_workflow ??
          get().armedWorkflow,
      });
    } catch {
      /* offline / no token */
    }

    try {
      const sess = await minimalFetch<{
        sessions?: SessionMeta[];
        current?: string | null;
      }>("/v1/sessions", { token });
      set({
        sessions: (sess.sessions ?? []).map((s) => ({
          ...s,
          preview: s.preview ?? s.last_user_preview,
        })),
        sessionId: sess.current ?? get().sessionId,
      });
    } catch {
      /* ignore */
    }

    try {
      const jobsRes = await minimalFetch<{
        jobs?: Array<{ id: string; status: string; label?: string }>;
      }>("/v1/jobs", { token });
      if (jobsRes.jobs) {
        set({
          jobs: jobsRes.jobs.map((j) => ({
            id: j.id,
            status: j.status,
            label: j.label,
          })),
        });
      }
    } catch {
      /* ignore */
    }

    void get().refreshCapabilities();
  },

  async loadHistory(sessionId?: string) {
    const sid = sessionId ?? get().sessionId;
    const path = sid
      ? `/v1/sessions/${encodeURIComponent(sid)}/messages`
      : "/v1/messages";
    const res = await minimalFetch<{
      session_id?: string;
      messages: SessionChatMessageDto[];
    }>(path, { token: get().token || getMinimalToken() });
    // Only replace when we actually got history (or explicit empty after switch)
    set({
      sessionId: res.session_id ?? get().sessionId,
      messages: applyToolExpandPolicy(
        (res.messages ?? []).map(fromHistoryDto),
      ),
    });
  },

  async refreshCapabilities() {
    try {
      const caps = await minimalFetch<RuntimeCapabilities>(
        "/v1/runtime/capabilities",
        { token: get().token || getMinimalToken() },
      );
      set({ capabilities: caps, lastError: undefined });
    } catch (e) {
      set({
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  async setCapability(kind, on) {
    if (get().isRunning) {
      return { ok: false, message: "agent is running — abort first" };
    }
    try {
      const body =
        kind === "shell" ? { shell: on } : { web: on };
      const caps = await minimalFetch<RuntimeCapabilities & { ok?: boolean }>(
        "/v1/runtime/capabilities",
        {
          method: "POST",
          body: JSON.stringify(body),
          token: get().token || getMinimalToken(),
        },
      );
      set({
        capabilities: {
          shell: caps.shell,
          web: caps.web,
          session_grants: caps.session_grants,
          always_grants: caps.always_grants,
          auth_open: caps.auth_open,
          hot_toggle: caps.hot_toggle ?? true,
        },
        lastError: undefined,
      });
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ lastError: message });
      return { ok: false, message };
    }
  },
}));
