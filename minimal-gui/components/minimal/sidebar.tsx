"use client";

import { useState } from "react";

import { useMinimalStore } from "@/lib/minimal/store";

function shortId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function statusDot(status?: string): string {
  if (status === "running") return "bg-cyan-500 animate-pulse";
  if (status === "done" || status === "completed" || status === "complete")
    return "bg-emerald-500";
  if (status === "failed" || status === "error" || status === "aborted")
    return "bg-red-500";
  return "bg-muted-foreground/40";
}

export function MinimalSidebar() {
  const sessions = useMinimalStore((s) => s.sessions);
  const sessionId = useMinimalStore((s) => s.sessionId);
  const isRunning = useMinimalStore((s) => s.isRunning);
  const switchSession = useMinimalStore((s) => s.switchSession);
  const createSession = useMinimalStore((s) => s.createSession);
  const deleteSession = useMinimalStore((s) => s.deleteSession);
  const setSessionNote = useMinimalStore((s) => s.setSessionNote);
  const workflows = useMinimalStore((s) => s.workflows);
  const armedWorkflow = useMinimalStore((s) => s.armedWorkflow);
  const armWorkflow = useMinimalStore((s) => s.armWorkflow);
  const workflowSteps = useMinimalStore((s) => s.workflowSteps);
  const clearWorkflowSteps = useMinimalStore((s) => s.clearWorkflowSteps);
  const jobs = useMinimalStore((s) => s.jobs);
  const connection = useMinimalStore((s) => s.connection);
  const refreshCatalog = useMinimalStore((s) => s.refreshCatalog);
  const loadHistory = useMinimalStore((s) => s.loadHistory);
  const loadedSkills = useMinimalStore((s) => s.loadedSkills);

  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r bg-muted/20">
      {/* Sessions */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold tracking-wide uppercase opacity-70">
          Sessions
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isRunning}
            className="text-[11px] font-medium text-primary opacity-80 hover:opacity-100 disabled:opacity-40"
            title="新建会话"
            onClick={() => void createSession()}
          >
            + new
          </button>
          <button
            type="button"
            className="text-[11px] opacity-60 hover:opacity-100"
            onClick={() => {
              void refreshCatalog();
              void loadHistory().catch(() => {});
            }}
            title="Refresh list + history"
          >
            refresh
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-[1.2] overflow-y-auto p-2">
        {connection !== "open" && (
          <p className="mb-2 rounded border border-dashed px-2 py-1.5 text-[11px] opacity-60">
            WS {connection}. Start{" "}
            <code className="text-[10px]">npm run web -- --no-auth</code>
          </p>
        )}
        {sessions.length === 0 ? (
          <p className="px-1 py-2 text-xs opacity-50">No sessions yet</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {sessions.map((s) => {
              const active = s.session_id === sessionId;
              const title = s.note?.trim() || shortId(s.session_id);
              const secondary =
                s.preview?.trim() ||
                s.last_user_preview?.trim() ||
                (s.task_count != null ? `${s.task_count} tasks` : "");
              const editing = editingNoteId === s.session_id;
              return (
                <li key={s.session_id} className="group relative">
                  {editing ? (
                    <form
                      className="rounded-md border border-primary/40 bg-background p-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void setSessionNote(s.session_id, noteDraft).then(() =>
                          setEditingNoteId(null),
                        );
                      }}
                    >
                      <input
                        autoFocus
                        className="w-full rounded border bg-muted/30 px-1.5 py-1 text-xs outline-none"
                        value={noteDraft}
                        maxLength={80}
                        placeholder="备注（空则清除）"
                        onChange={(e) => setNoteDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setEditingNoteId(null);
                        }}
                      />
                      <div className="mt-1 flex justify-end gap-1">
                        <button
                          type="button"
                          className="px-1.5 text-[10px] opacity-60"
                          onClick={() => setEditingNoteId(null)}
                        >
                          取消
                        </button>
                        <button
                          type="submit"
                          className="rounded bg-primary/15 px-1.5 text-[10px] text-primary"
                        >
                          保存
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div
                      className={[
                        "rounded-md border px-2 py-1.5 text-left text-xs transition",
                        active
                          ? "border-primary/40 bg-primary/10"
                          : "border-transparent hover:border-border hover:bg-muted/50",
                      ].join(" ")}
                    >
                      <button
                        type="button"
                        disabled={isRunning}
                        onClick={() => void switchSession(s.session_id)}
                        className={[
                          "w-full text-left",
                          isRunning ? "cursor-not-allowed opacity-50" : "",
                        ].join(" ")}
                      >
                        <div className="truncate font-medium">{title}</div>
                        {secondary && (
                          <div
                            className="mt-0.5 line-clamp-2 text-[10px] leading-snug opacity-60"
                            title={secondary}
                          >
                            {secondary}
                          </div>
                        )}
                        <div className="mt-0.5 font-mono text-[10px] opacity-40">
                          {shortId(s.session_id)}
                          {s.task_count != null ? ` · ${s.task_count}t` : ""}
                        </div>
                      </button>
                      <div className="mt-1 flex gap-2 opacity-0 transition group-hover:opacity-100">
                        <button
                          type="button"
                          className="text-[10px] opacity-70 hover:opacity-100"
                          title="编辑备注"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingNoteId(s.session_id);
                            setNoteDraft(s.note ?? "");
                          }}
                        >
                          note
                        </button>
                        <button
                          type="button"
                          disabled={isRunning}
                          className="text-[10px] text-red-600/80 hover:text-red-600 disabled:opacity-40"
                          title="删除会话"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (
                              window.confirm(
                                `删除会话 ${shortId(s.session_id)}？\n不可恢复。`,
                              )
                            ) {
                              void deleteSession(s.session_id);
                            }
                          }}
                        >
                          del
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Workflows */}
      <div className="border-t">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-semibold tracking-wide uppercase opacity-70">
            Workflows
          </span>
          {armedWorkflow && (
            <button
              type="button"
              className="text-[11px] text-amber-600 hover:underline"
              onClick={() => void armWorkflow(null)}
            >
              disarm
            </button>
          )}
        </div>
        {armedWorkflow && (
          <div className="mx-2 mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200">
            Armed: <span className="font-mono">{armedWorkflow}</span>
            <div className="opacity-70">Next message = workflow task</div>
          </div>
        )}
        <div className="max-h-32 overflow-y-auto px-2 pb-2">
          {workflows.length === 0 ? (
            <p className="px-1 text-[11px] opacity-50">No workflows</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {workflows.map((w) => {
                const name = w.name;
                const armed = armedWorkflow === name;
                return (
                  <li key={name}>
                    <button
                      type="button"
                      disabled={isRunning}
                      onClick={() => void armWorkflow(armed ? null : name)}
                      className={[
                        "w-full truncate rounded px-2 py-1 text-left text-[11px]",
                        armed
                          ? "bg-amber-500/15 font-medium"
                          : "hover:bg-muted/60",
                        isRunning ? "opacity-50" : "",
                      ].join(" ")}
                    >
                      {name}
                      {w.kind ? (
                        <span className="ml-1 opacity-40">{w.kind}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Workflow steps */}
      <div className="border-t px-2 py-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase opacity-60">
            Steps
          </span>
          {workflowSteps.length > 0 && (
            <button
              type="button"
              className="text-[10px] opacity-50 hover:opacity-100"
              onClick={() => clearWorkflowSteps()}
            >
              clear
            </button>
          )}
        </div>
        <div className="max-h-28 space-y-1 overflow-y-auto">
          {workflowSteps.length === 0 ? (
            <p className="text-[11px] opacity-40">—</p>
          ) : (
            workflowSteps.slice(-12).map((st, i) => (
              <div
                key={st.id}
                className="flex items-start gap-1.5 text-[10px] opacity-80"
              >
                <span
                  className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(st.status)}`}
                />
                <div className="min-w-0 font-mono leading-snug">
                  <div className="truncate">
                    {i + 1}. {st.nodeId || st.role}
                  </div>
                  <div className="opacity-50">
                    {st.phase}
                    {st.status ? ` · ${st.status}` : ""}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Jobs */}
      <div className="border-t px-2 py-2">
        <div className="mb-1 text-[10px] font-semibold uppercase opacity-60">
          Jobs
        </div>
        <div className="max-h-28 space-y-1 overflow-y-auto">
          {jobs.length === 0 ? (
            <p className="text-[11px] opacity-40">—</p>
          ) : (
            jobs.slice(0, 12).map((j) => (
              <div
                key={j.id}
                className="flex items-center gap-1.5 rounded border border-border/50 px-1.5 py-0.5 font-mono text-[10px]"
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(j.status)}`}
                />
                <span className="min-w-0 truncate opacity-80">
                  {j.label || j.id.slice(0, 14)}
                </span>
                <span className="ml-auto shrink-0 opacity-50">{j.status}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {loadedSkills.length > 0 && (
        <div className="border-t px-2 py-1.5 text-[10px] opacity-60">
          skills: {loadedSkills.join(", ")}
        </div>
      )}
    </aside>
  );
}
