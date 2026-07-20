"use client";

import { create } from "zustand";

import { getMinimalToken, minimalFetch, rememberToken } from "./client";
import {
  applyToolExpandPolicy,
  collapseToolsExceptLatestTurn,
  ensureUniqueMessageIds,
  fromHistoryDto,
  joinContent,
  newMsgId,
  preferRicherToolMessages,
  preserveLiveMessageIds,
  projectAssistantFinal,
} from "./convert";
import { inferToolName } from "./tool-parse";
import { shouldAutoExpandTool } from "./tool-tiers";
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
  PermissionConfirmPending,
  WorkflowConfirmPending,
  WorkflowMeta,
  WorkspaceSnapshot,
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

  /** JIT path_escape (outside cwd read). */
  permissionConfirm: PermissionConfirmPending | null;
  permissionConfirmBusy: boolean;

  /** Sync spawn_agent activity (child stream not mixed into main bubbles). */
  activeSpawns: ActiveSpawn[];

  /** Shell / web process flags (Settings + optional WS sync). */
  capabilities: RuntimeCapabilities | null;

  /** active_cwd + path grants. */
  workspace: WorkspaceSnapshot | null;

  /**
   * Bumps after loadHistory/sync so the thread can re-pin scroll without
   * remount thrash (post-run delayed refresh on slower machines).
   */
  historySyncGen: number;

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
  /** Catalog + history — manual / switch only; not auto on run_end. */
  syncSessionView: () => Promise<void>;
  /** Sidebar list only (session Recap / task_count) — does not touch chat body. */
  refreshSessionList: () => Promise<void>;
  /** Patch current session card Recap from live final meta. */
  patchSessionRecap: (meta: {
    current_work?: string;
    pending_tasks?: string[];
  }) => void;
  respondWorkflowConfirm: (approved: boolean) => Promise<void>;
  respondPermissionConfirm: (
    choice: "once" | "session" | "deny",
  ) => Promise<void>;
  refreshCapabilities: () => Promise<void>;
  setCapability: (
    kind: "shell" | "web",
    on: boolean,
  ) => Promise<{ ok: boolean; message?: string }>;
  refreshWorkspace: () => Promise<void>;
  workspaceAllow: (opts: {
    path: string;
    mode?: "read_only" | "read_write";
    shell?: boolean;
    web?: boolean;
  }) => Promise<{ ok: boolean; message?: string }>;
  workspaceRevoke: (path: string) => Promise<{ ok: boolean; message?: string }>;
  workspaceSetCwd: (
    path: string,
    opts?: { grant_if_missing?: boolean },
  ) => Promise<{ ok: boolean; message?: string }>;
  workspaceGoPrimary: () => Promise<{ ok: boolean; message?: string }>;
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

/** Walk past trailing tool/system rows to a still-running assistant (same turn). */
function findLastRunningAssistantIndex(messages: MinimalMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.status === "running") return i;
    if (m.role === "user") return -1;
  }
  return -1;
}

function lastAssistantMeta(
  messages: MinimalMessage[],
): { current_work?: string; pending_tasks?: string[] } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.meta) {
      const work = m.meta.current_work?.trim();
      const pending = m.meta.pending_tasks?.filter((t) => String(t).trim());
      if (work || pending?.length) {
        return {
          current_work: work || undefined,
          pending_tasks: pending?.map(String),
        };
      }
    }
  }
  return undefined;
}

function applyRecapToSessions(
  sessions: SessionMeta[],
  sessionId: string | null,
  meta: { current_work?: string; pending_tasks?: string[] } | undefined,
): SessionMeta[] {
  if (!sessionId || !meta) return sessions;
  const work = meta.current_work?.trim();
  const pending = meta.pending_tasks?.filter((t) => String(t).trim()) ?? [];
  if (!work && !pending.length) return sessions;
  const preview = work || pending[0] || undefined;
  return sessions.map((s) =>
    s.session_id === sessionId
      ? {
          ...s,
          preview,
          current_work: work || s.current_work,
          pending_tasks: pending.length ? pending : s.pending_tasks,
        }
      : s,
  );
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

  // run_end with tools/system after the assistant: seal without inventing a new bubble
  if (!hasExplicit) {
    const ai = findLastRunningAssistantIndex(next);
    if (ai >= 0) {
      const target = next[ai]!;
      const projected = projectAssistantFinal(joinContent(target));
      next[ai] = {
        ...target,
        content: projected.content,
        contentChunks: undefined,
        meta: projected.meta ?? target.meta,
        viewKind: projected.viewKind ?? target.viewKind,
        status: "complete",
      };
    }
    return next;
  }

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
  permissionConfirm: null,
  permissionConfirmBusy: false,
  activeSpawns: [],
  capabilities: null,
  workspace: null,
  historySyncGen: 0,

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
      messages: ensureUniqueMessageIds(
        applyToolExpandPolicy(rows.map((row, i) => fromHistoryDto(row, i))),
      ),
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
            permissionConfirm: (() => {
              const pc = frame.permission_confirm;
              if (pc && (pc.status === "pending" || !pc.status) && pc.reason) {
                return { kind: pc.kind, reason: pc.reason };
              }
              return get().permissionConfirm;
            })(),
            workspace: frame.workspace
              ? {
                  active_cwd: frame.workspace.active_cwd,
                  primary: frame.workspace.primary,
                  project_id: frame.workspace.project_id,
                  project_name: frame.workspace.project_name,
                  session_store: frame.workspace.session_store,
                  capability_policy: frame.workspace.capability_policy,
                  grants: frame.workspace.grants ?? [],
                }
              : get().workspace,
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
            const sid = frame.session_id ?? s.sessionId;
            // One-shot arm: run start consumes it (server also broadcasts null).
            const armedWorkflow = running
              ? null
              : s.armedWorkflow;
            return {
              isRunning: running,
              sessionId: sid,
              model: frame.model ?? s.model,
              messages,
              armedWorkflow,
              sessions: ending
                ? applyRecapToSessions(
                    s.sessions,
                    sid,
                    lastAssistantMeta(messages),
                  )
                : s.sessions,
              // Gate only lives while a workflow is waiting — clear on terminal states
              workflowConfirm: ending ? null : s.workflowConfirm,
              workflowConfirmBusy: ending ? false : s.workflowConfirmBusy,
              // path_escape wait is mid-run; only clear busy flag on hard end
              permissionConfirm: ending ? null : s.permissionConfirm,
              permissionConfirmBusy: ending ? false : s.permissionConfirmBusy,
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
          const name = frame.name?.trim() || null;
          const path = frame.path?.trim() || null;
          // Empty path+name = disarmed (server one-shot consume / explicit off).
          set({
            armedWorkflow: name || path || null,
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
            armedWorkflow: null,
            workflowSteps: [],
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
        case "permission_confirm": {
          if (frame.status === "pending" && frame.reason) {
            set({
              permissionConfirm: {
                kind: frame.kind,
                reason: frame.reason,
              },
              permissionConfirmBusy: false,
            });
          } else {
            set({
              permissionConfirm: null,
              permissionConfirmBusy: false,
            });
          }
          return;
        }
        case "workspace": {
          set({
            workspace: {
              active_cwd: frame.active_cwd,
              primary: frame.primary,
              project_id: frame.project_id,
              project_name: frame.project_name,
              session_store: frame.session_store,
              capability_policy: frame.capability_policy,
              grants: frame.grants ?? [],
            },
          });
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
      args?: string;
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
    // spawn_* virtual sessions are always child (even if source tag was dropped)
    const isSpawnSessionId =
      typeof frameSession === "string" && frameSession.startsWith("spawn_");
    const isChildAgentStream =
      bridgeSource === "job" ||
      bridgeSource === "spawn" ||
      isSpawnSessionId ||
      (Boolean(frameSession) &&
        Boolean(currentSession) &&
        frameSession !== currentSession);

    // Settlement notices are tagged source=job but use parent session_id —
    // still allow system_notice onto the main timeline (short digests only).
    if (isChildAgentStream && role !== "system_notice") {
      const spawnKey =
        sm.source_id ||
        frameSession ||
        (bridgeSource === "spawn" ? "spawn" : "job");
      // source_id for jobs is job_id; for sync spawn is often the preset name
      const presetLabel =
        bridgeSource === "spawn"
          ? sm.source_id || "spawn"
          : bridgeSource === "job"
            ? sm.source_id || spawnKey
            : sm.source_id || spawnKey;

      // Background jobs: jobs panel only — never main bubbles / activity prose
      if (bridgeSource === "job" || (isSpawnSessionId && sm.source_id?.startsWith("job_"))) {
        if (role === "tool" || (role === "assistant" && (sm.content || sm.delta))) {
          set((s) => {
            const jobs = [...s.jobs];
            const id =
              sm.source_id?.startsWith("job_")
                ? sm.source_id
                : sm.source_id || spawnKey;
            const i = jobs.findIndex((j) => j.id === id);
            const tool =
              role === "tool"
                ? inferToolName(sm.tool_name, sm.content)
                : undefined;
            const row = {
              id,
              status: "running" as const,
              label: jobs[i]?.label || tool || id.slice(0, 14),
            };
            if (i >= 0) {
              jobs[i] = {
                ...jobs[i]!,
                status: "running",
                label: jobs[i]!.label || row.label,
              };
            } else jobs.unshift(row);
            return { jobs: jobs.slice(0, 20) };
          });
        }
        return;
      }

      // Sync spawn / other child: activity strip only — drop token deltas
      if (role === "assistant" && sm.delta) {
        // Touch strip so user sees "spawn running" without dumping prose
        set((s) => {
          const list = [...s.activeSpawns];
          let row = list.find(
            (x) => x.id === spawnKey || x.preset === presetLabel,
          );
          if (!row) {
            list.unshift({
              id: spawnKey,
              preset: String(presetLabel),
              status: "running",
              preview: "",
            });
            return { activeSpawns: list.slice(0, 6) };
          }
          return s;
        });
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
            preset: String(presetLabel),
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
          preset: row.preset || String(presetLabel),
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
        set((s) => {
          const messages = finalizeAssistant(s.messages, content);
          const recap = lastAssistantMeta(messages);
          return {
            messages,
            sessions: applyRecapToSessions(s.sessions, s.sessionId, recap),
          };
        });
      }
      return;
    }

    if (role === "tool") {
      // Live tools open while run is active; real name via inferToolName.
      const name = inferToolName(toolName, content);
      const argsJson = typeof sm.args === "string" ? sm.args : undefined;
      // Bridge only emits tool_result (already finished) — never keep as running.
      const status = "complete" as const;
      const expand = shouldAutoExpandTool({
        toolName: name,
        content: content ?? "",
        status,
        inLatestTurn: true,
      });
      set((s) => {
        // Seal any prior "running" tools so status strip won't stick on them.
        const sealed = s.messages.map((m) =>
          m.role === "tool" && m.status === "running"
            ? { ...m, status: "complete" as const }
            : m,
        );
        return {
          messages: [
            ...sealed,
            {
              id: newMsgId("t"),
              role: "tool" as const,
              content: content ?? "",
              toolName: name,
              callId,
              argsJson,
              status,
              source: "live" as const,
              viewKind: "tool" as const,
              toolExpanded: expand,
            },
          ],
        };
      });
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
    // Nudge thread viewport after layout (Thread StickToBottomOnSend also watches isRunning)
    if (typeof document !== "undefined") {
      requestAnimationFrame(() => {
        const el = document.querySelector(
          '[data-slot="aui_thread-viewport"]',
        ) as HTMLElement | null;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }

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
      set({
        workflowConfirm: null,
        workflowConfirmBusy: false,
        permissionConfirm: null,
        permissionConfirmBusy: false,
      });
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
      set({ workflowConfirm: null, workflowConfirmBusy: false });
    } catch (e) {
      set({
        workflowConfirmBusy: false,
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  async respondPermissionConfirm(choice: "once" | "session" | "deny") {
    if (get().permissionConfirmBusy) return;
    set({ permissionConfirmBusy: true });
    try {
      await minimalFetch("/v1/permission/confirm", {
        method: "POST",
        body: JSON.stringify({ choice }),
        token: get().token || getMinimalToken(),
      });
      set({ permissionConfirm: null, permissionConfirmBusy: false });
    } catch (e) {
      set({
        permissionConfirmBusy: false,
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
        messages: ensureUniqueMessageIds(
          applyToolExpandPolicy(
            (res.messages ?? []).map((row, i) => fromHistoryDto(row, i)),
          ),
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
    // Optimistic remove so the card disappears immediately; refresh reconciles.
    const prevSessions = get().sessions;
    const wasCurrent = id === get().sessionId;
    set({
      sessions: prevSessions.filter((s) => s.session_id !== id),
      lastError: undefined,
    });
    try {
      const res = await minimalFetch<{
        ok?: boolean;
        deleted?: string;
        session_id?: string | null;
        profile?: string | null;
        model?: string | null;
      }>(`/v1/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        token: get().token || getMinimalToken(),
      });
      if (wasCurrent) {
        set({
          sessionId: res.session_id ?? null,
          messages: [],
          workflowSteps: [],
          profile: res.profile ?? get().profile,
          model: res.model ?? get().model,
        });
        if (res.session_id && res.session_id !== id) {
          await get().loadHistory(res.session_id).catch(() => {
            set({ messages: [] });
          });
        } else if (!res.session_id) {
          set({ messages: [] });
        }
      }
      await get().refreshCatalog();
      // Guard: never let a failed/zombie disk entry put the deleted id back
      // if the API confirmed deletion (or we already dropped it optimistically).
      if (get().sessions.some((s) => s.session_id === id)) {
        set({
          sessions: get().sessions.filter((s) => s.session_id !== id),
        });
      }
    } catch (e) {
      // Roll back list if delete failed so user sees the card + error.
      set({
        sessions: prevSessions,
        lastError:
          e instanceof Error
            ? `删除失败: ${e.message}`
            : `删除失败: ${String(e)}`,
      });
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
      const res = await minimalFetch<{ loaded?: string[] }>("/v1/skills/clear", {
        method: "POST",
        body: "{}",
        token: get().token || getMinimalToken(),
      });
      // Sticky agent.json skills may remain after clearing one-shot arms.
      set({
        loadedSkills: res.loaded ?? [],
        lastError: undefined,
      });
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
        // null must clear local arm; ?? would treat null as missing and stick.
        armedWorkflow: (() => {
          const llmArm = cat.llm?.armed_workflow;
          if (llmArm !== undefined) return llmArm;
          if (cat.armed_workflow !== undefined) return cat.armed_workflow;
          return get().armedWorkflow;
        })(),
      });
    } catch {
      /* offline / no token */
    }

    try {
      const sess = await minimalFetch<{
        sessions?: SessionMeta[];
        current?: string | null;
      }>("/v1/sessions", { token });
      const prev = get().sessions;
      const prevById = new Map(prev.map((s) => [s.session_id, s]));
      set({
        sessions: (sess.sessions ?? []).map((s) => {
          const old = prevById.get(s.session_id);
          const preview =
            s.preview ?? s.last_user_preview ?? old?.preview;
          return {
            ...s,
            preview,
            // Keep live Recap if catalog row is thinner
            current_work: old?.current_work,
            pending_tasks: old?.pending_tasks,
          };
        }),
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
    const prev = get().messages;
    const incoming = applyToolExpandPolicy(
      (res.messages ?? []).map((row, i) => fromHistoryDto(row, i)),
    );
    // Post-run sync must not clobber live write/edit diffs with bare "ok:" rows.
    const richer = preferRicherToolMessages(prev, incoming);
    // Keep live React keys when logical messages still match — stops delayed
    // "顶飞" when post-run history reload remounts the whole thread.
    // ensureUniqueMessageIds is required: assistant-ui MessageRepository throws
    // if the same id appears twice (seen after skeleton-reader / multi-tool runs).
    const merged = ensureUniqueMessageIds(
      preserveLiveMessageIds(prev, richer),
    );
    set({
      sessionId: res.session_id ?? get().sessionId,
      messages: ensureUniqueMessageIds(applyToolExpandPolicy(merged)),
      historySyncGen: get().historySyncGen + 1,
    });
  },

  async syncSessionView() {
    // Manual full sync: list + optional body reload (not used on run_end).
    await get().refreshCatalog();
    try {
      await get().loadHistory();
    } catch {
      /* empty / offline ok */
    }
  },

  async refreshSessionList() {
    await get().refreshCatalog();
  },

  patchSessionRecap(meta) {
    set((s) => ({
      sessions: applyRecapToSessions(s.sessions, s.sessionId, meta),
    }));
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

  async refreshWorkspace() {
    try {
      const snap = await minimalFetch<WorkspaceSnapshot & { ok?: boolean }>(
        "/v1/workspace",
        { token: get().token || getMinimalToken() },
      );
      set({
        workspace: {
          active_cwd: snap.active_cwd,
          primary: snap.primary,
          project_id: snap.project_id,
          project_name: snap.project_name,
          session_store: snap.session_store,
          capability_policy: snap.capability_policy,
          grants: snap.grants ?? [],
        },
        lastError: undefined,
      });
    } catch (e) {
      set({
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  async workspaceAllow(opts) {
    if (get().isRunning) {
      return { ok: false, message: "agent is running — abort first" };
    }
    try {
      const snap = await minimalFetch<WorkspaceSnapshot & { ok?: boolean }>(
        "/v1/workspace/allow",
        {
          method: "POST",
          body: JSON.stringify({
            path: opts.path,
            mode: opts.mode ?? "read_write",
            shell: opts.shell === true,
            web: opts.web === true,
          }),
          token: get().token || getMinimalToken(),
        },
      );
      set({
        workspace: {
          active_cwd: snap.active_cwd,
          primary: snap.primary,
          project_id: snap.project_id,
          project_name: snap.project_name,
          session_store: snap.session_store,
          capability_policy: snap.capability_policy,
          grants: snap.grants ?? [],
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

  async workspaceRevoke(path) {
    if (get().isRunning) {
      return { ok: false, message: "agent is running — abort first" };
    }
    try {
      const snap = await minimalFetch<WorkspaceSnapshot & { ok?: boolean }>(
        "/v1/workspace/revoke",
        {
          method: "POST",
          body: JSON.stringify({ path }),
          token: get().token || getMinimalToken(),
        },
      );
      set({
        workspace: {
          active_cwd: snap.active_cwd,
          primary: snap.primary,
          project_id: snap.project_id,
          project_name: snap.project_name,
          session_store: snap.session_store,
          capability_policy: snap.capability_policy,
          grants: snap.grants ?? [],
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

  async workspaceSetCwd(path, opts) {
    if (get().isRunning) {
      return { ok: false, message: "agent is running — abort first" };
    }
    try {
      const snap = await minimalFetch<
        WorkspaceSnapshot & RuntimeCapabilities & { ok?: boolean }
      >("/v1/workspace/cwd", {
        method: "POST",
        body: JSON.stringify({
          path,
          grant_if_missing: opts?.grant_if_missing === true,
        }),
        token: get().token || getMinimalToken(),
      });
      set({
        workspace: {
          active_cwd: snap.active_cwd,
          primary: snap.primary,
          project_id: snap.project_id,
          project_name: snap.project_name,
          session_store: snap.session_store,
          capability_policy: snap.capability_policy,
          grants: snap.grants ?? [],
        },
        capabilities:
          typeof snap.shell === "boolean"
            ? {
                shell: snap.shell,
                web: snap.web,
                session_grants: snap.session_grants,
                always_grants: snap.always_grants,
                auth_open: snap.auth_open,
                hot_toggle: snap.hot_toggle,
              }
            : get().capabilities,
        lastError: undefined,
      });
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ lastError: message });
      return { ok: false, message };
    }
  },

  async workspaceGoPrimary() {
    if (get().isRunning) {
      return { ok: false, message: "agent is running — abort first" };
    }
    try {
      const snap = await minimalFetch<
        WorkspaceSnapshot & RuntimeCapabilities & { ok?: boolean }
      >("/v1/workspace/primary", {
        method: "POST",
        body: "{}",
        token: get().token || getMinimalToken(),
      });
      set({
        workspace: {
          active_cwd: snap.active_cwd,
          primary: snap.primary,
          project_id: snap.project_id,
          project_name: snap.project_name,
          session_store: snap.session_store,
          capability_policy: snap.capability_policy,
          grants: snap.grants ?? [],
        },
        capabilities:
          typeof snap.shell === "boolean"
            ? {
                shell: snap.shell,
                web: snap.web,
                session_grants: snap.session_grants,
                always_grants: snap.always_grants,
                auth_open: snap.auth_open,
                hot_toggle: snap.hot_toggle,
              }
            : get().capabilities,
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
