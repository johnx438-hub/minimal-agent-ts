"use client";

/**
 * Sits under the Thread (composer is sticky at bottom of Thread).
 * Matches assistant-ui shell tokens: large radius + soft border/shadow.
 */

import { useMinimalStore } from "@/lib/minimal/store";

export function ComposerChrome() {
  const isRunning = useMinimalStore((s) => s.isRunning);
  const profiles = useMinimalStore((s) => s.profiles);
  const models = useMinimalStore((s) => s.models);
  const profile = useMinimalStore((s) => s.profile);
  const model = useMinimalStore((s) => s.model);
  const setProfile = useMinimalStore((s) => s.setProfile);
  const setModel = useMinimalStore((s) => s.setModel);
  const skills = useMinimalStore((s) => s.skills);
  const loadedSkills = useMinimalStore((s) => s.loadedSkills);
  const loadSkill = useMinimalStore((s) => s.loadSkill);
  const clearLoadedSkills = useMinimalStore((s) => s.clearLoadedSkills);
  const armedWorkflow = useMinimalStore((s) => s.armedWorkflow);
  const armWorkflow = useMinimalStore((s) => s.armWorkflow);
  const abort = useMinimalStore((s) => s.abort);

  const activeProfile =
    profiles.find((p) => p.active)?.name ?? profile ?? profiles[0]?.name ?? "";
  const activeModel =
    models.find((m) => m.active)?.model ?? model ?? models[0]?.model ?? "";

  return (
    <div
      className="border-border/60 bg-background/95 shrink-0 border-t px-3 pt-2 pb-3 backdrop-blur-sm"
      style={
        {
          ["--chrome-radius" as string]: "1.5rem",
        } as React.CSSProperties
      }
    >
      {/* Profile / Model — under chat column, above skills */}
      <div
        className="border-border/60 mb-2 flex flex-wrap items-center gap-2 rounded-[var(--chrome-radius)] border bg-muted/30 px-3 py-2 text-xs shadow-[0_2px_12px_-6px_rgba(0,0,0,0.08)]"
      >
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Profile</span>
          <select
            className="border-border/60 max-w-[150px] rounded-full border bg-background px-2.5 py-1 disabled:opacity-40"
            disabled={isRunning || profiles.length === 0}
            value={activeProfile}
            onChange={(e) => void setProfile(e.target.value)}
          >
            {profiles.length === 0 && <option value="">—</option>}
            {profiles.map((p) => (
              <option
                key={p.name}
                value={p.name}
                disabled={p.available === false}
              >
                {p.displayName || p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Model</span>
          <select
            className="border-border/60 max-w-[200px] rounded-full border bg-background px-2.5 py-1 disabled:opacity-40"
            disabled={isRunning || models.length === 0}
            value={activeModel}
            onChange={(e) => void setModel(e.target.value)}
          >
            {models.length === 0 && (
              <option value={model ?? ""}>{model || "—"}</option>
            )}
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.model}
              </option>
            ))}
          </select>
        </label>

        {armedWorkflow && (
          <span className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100 rounded-full border px-2.5 py-0.5 text-[11px]">
            armed <span className="font-mono">{armedWorkflow}</span>
            <button
              type="button"
              className="ml-1 opacity-70 hover:opacity-100"
              onClick={() => void armWorkflow(null)}
            >
              ×
            </button>
          </span>
        )}

        <div className="flex-1" />

        {isRunning && (
          <button
            type="button"
            className="border-red-500/40 text-red-600 hover:bg-red-500/10 rounded-full border px-3 py-0.5 text-[11px]"
            onClick={() => void abort()}
          >
            中止
          </button>
        )}
      </div>

      {/* Skills under message input column */}
      <div className="border-border/60 flex flex-wrap items-center gap-1.5 rounded-[var(--chrome-radius)] border bg-muted/20 px-3 py-2">
        <span className="text-muted-foreground mr-1 text-[11px]">Skills</span>
        {skills.length === 0 ? (
          <span className="text-[11px] opacity-40">无可用 skill</span>
        ) : (
          skills.slice(0, 12).map((sk) => {
            const on = loadedSkills.includes(sk.name);
            return (
              <button
                key={sk.name}
                type="button"
                title={sk.description || sk.name}
                disabled={on}
                onClick={() => void loadSkill(sk.name)}
                className={[
                  "rounded-full border px-2.5 py-0.5 text-[11px] transition",
                  on
                    ? "border-primary/30 bg-primary/10 opacity-80"
                    : "border-border/60 hover:bg-muted/60",
                  "disabled:cursor-default",
                ].join(" ")}
              >
                {on ? `✓ ${sk.name}` : sk.name}
              </button>
            );
          })
        )}
        {loadedSkills.length > 0 && (
          <button
            type="button"
            className="text-muted-foreground ml-auto text-[11px] underline-offset-2 hover:underline"
            onClick={() => void clearLoadedSkills()}
            title="进程级清空，跨 session 残留一并清掉"
          >
            清空已加载
          </button>
        )}
      </div>
      <p className="text-muted-foreground mt-1.5 px-1 text-[10px] leading-snug opacity-70">
        Skills 为进程级注入（切 session 不会自动卸下）。Memory 为工作区文件，本就跨会话。
        命令：/skills clear · /help
      </p>
    </div>
  );
}
