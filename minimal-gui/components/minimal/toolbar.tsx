"use client";

import { useMinimalStore } from "@/lib/minimal/store";

export function MinimalToolbar() {
  const isRunning = useMinimalStore((s) => s.isRunning);
  const profiles = useMinimalStore((s) => s.profiles);
  const models = useMinimalStore((s) => s.models);
  const profile = useMinimalStore((s) => s.profile);
  const model = useMinimalStore((s) => s.model);
  const setProfile = useMinimalStore((s) => s.setProfile);
  const setModel = useMinimalStore((s) => s.setModel);
  const abort = useMinimalStore((s) => s.abort);
  const armedWorkflow = useMinimalStore((s) => s.armedWorkflow);
  const armWorkflow = useMinimalStore((s) => s.armWorkflow);
  const skills = useMinimalStore((s) => s.skills);
  const loadedSkills = useMinimalStore((s) => s.loadedSkills);
  const loadSkill = useMinimalStore((s) => s.loadSkill);

  const activeProfile =
    profiles.find((p) => p.active)?.name ?? profile ?? profiles[0]?.name ?? "";
  const activeModel =
    models.find((m) => m.active)?.model ?? model ?? models[0]?.model ?? "";

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs">
      <label className="flex items-center gap-1.5 opacity-80">
        <span className="opacity-60">Profile</span>
        <select
          className="max-w-[140px] rounded border bg-background px-1.5 py-0.5 disabled:opacity-40"
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
              {p.available === false ? " (n/a)" : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 opacity-80">
        <span className="opacity-60">Model</span>
        <select
          className="max-w-[180px] rounded border bg-background px-1.5 py-0.5 disabled:opacity-40"
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

      {skills.length > 0 && (
        <label className="flex items-center gap-1.5 opacity-80">
          <span className="opacity-60">Skill</span>
          <select
            className="max-w-[140px] rounded border bg-background px-1.5 py-0.5"
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value;
              if (v) void loadSkill(v);
              e.target.value = "";
            }}
          >
            <option value="">load…</option>
            {skills.map((sk) => (
              <option
                key={sk.name}
                value={sk.name}
                disabled={loadedSkills.includes(sk.name)}
              >
                {loadedSkills.includes(sk.name) ? `✓ ${sk.name}` : sk.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {armedWorkflow && (
        <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-800 dark:text-amber-200">
          armed: <span className="font-mono">{armedWorkflow}</span>
          <button
            type="button"
            className="ml-1.5 underline opacity-70 hover:opacity-100"
            onClick={() => void armWorkflow(null)}
          >
            ×
          </button>
        </span>
      )}

      <span className="hidden text-[10px] opacity-40 sm:inline" title="Type slash commands in the composer">
        slash: /help /profile /model /workflow /skills /stop
      </span>

      <div className="flex-1" />

      {isRunning && (
        <button
          type="button"
          className="rounded border border-red-500/50 px-2 py-0.5 text-red-600 hover:bg-red-500/10"
          onClick={() => void abort()}
        >
          Abort
        </button>
      )}
    </div>
  );
}
