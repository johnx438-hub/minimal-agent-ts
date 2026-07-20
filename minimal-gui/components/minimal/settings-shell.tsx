"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  SETTINGS_GUIDES,
  type GuideSectionId,
} from "@/content/guides";
import { getMinimalToken, isMinimalAuthOptional, minimalFetch } from "@/lib/minimal/client";
import { useMinimalStore } from "@/lib/minimal/store";
import { cn } from "@/lib/utils";

type SectionId = GuideSectionId;

const NAV: Array<{ id: SectionId; label: string; hint: string }> = [
  { id: "overview", label: "概览", hint: "连接与当前会话" },
  { id: "permissions", label: "权限与能力", hint: "shell / web" },
  { id: "workspace", label: "工作区", hint: "cwd / grants" },
  { id: "presets", label: "子 Agent", hint: "spawn 预设" },
  { id: "mcp", label: "MCP", hint: "连接状态与配置" },
  { id: "guides", label: "指南", hint: "1–3 句教程" },
];

type McpServerStatusDto = {
  name: string;
  enabled: boolean;
  transport: string | null;
  endpoint: string | null;
  auth: string;
  connected: boolean;
  tool_count: number;
  error?: string;
};

type McpStatusDto = {
  ok?: boolean;
  servers?: McpServerStatusDto[];
  tools?: Array<{
    apiName: string;
    serverName: string;
    toolName: string;
    description: string;
  }>;
  policy?: { allow?: string[]; deny?: string[] };
  config_hint?: string;
};

type SpawnPresetDto = {
  name: string;
  description?: string;
  tools: string[];
  max_turns?: number;
  prompt_file?: string;
  api_profile?: string | null;
  model?: string | null;
  needs_shell?: boolean;
  needs_web?: boolean;
  registered?: boolean;
};

type HealthDto = {
  ok?: boolean;
  running?: boolean;
  session_id?: string | null;
  model?: string | null;
  profile?: string | null;
  armed_workflow?: string | null;
  shell?: boolean;
  web?: boolean;
  auth_open?: boolean;
};

function SectionCard({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "border-border/60 rounded-xl border bg-muted/20 px-4 py-3",
        className,
      )}
    >
      <h2 className="mb-2 text-sm font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function GuidesPanel({
  onNavigate,
}: {
  onNavigate: (id: SectionId) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(
    SETTINGS_GUIDES[0]?.id ?? null,
  );

  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="怎么用 minimal">
        <p className="text-muted-foreground mb-3 text-[12px] leading-relaxed">
          每条 1–3
          句，可扫读。需要动手的能力会链到 Settings 对应分区；模型与 Skills
          仍在聊天栏。
        </p>
        <ul className="flex flex-col gap-2">
          {SETTINGS_GUIDES.map((g) => {
            const open = openId === g.id;
            return (
              <li
                key={g.id}
                className="border-border/50 rounded-lg border bg-background/50"
              >
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
                  onClick={() => setOpenId(open ? null : g.id)}
                >
                  <span className="text-[13px] font-medium">{g.title}</span>
                  <span className="text-muted-foreground text-[11px]">
                    {open ? "收起" : "展开"}
                  </span>
                </button>
                {open && (
                  <div className="border-border/40 space-y-2 border-t px-3 py-2.5">
                    <ul className="text-muted-foreground list-inside list-disc space-y-1.5 text-[12px] leading-relaxed">
                      {g.body.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                    {(g.refs?.length || g.related) && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {g.related && (
                          <button
                            type="button"
                            className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] text-primary"
                            onClick={() => onNavigate(g.related!)}
                          >
                            打开「
                            {NAV.find((n) => n.id === g.related)?.label ??
                              g.related}
                            」
                          </button>
                        )}
                        {g.refs?.map((r) => (
                          <span
                            key={r}
                            className="bg-muted rounded px-1.5 py-0.5 font-mono text-[10px] opacity-80"
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </SectionCard>
    </div>
  );
}

function CapToggle({
  label,
  description,
  on,
  disabled,
  busy,
  always,
  session,
  onToggle,
}: {
  label: string;
  description: string;
  on: boolean;
  disabled?: boolean;
  busy?: boolean;
  always?: boolean;
  session?: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div className="border-border/50 flex items-start justify-between gap-3 rounded-lg border bg-background/50 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-medium">{label}</span>
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              on
                ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200"
                : "bg-muted text-muted-foreground",
            )}
          >
            {on ? "ON" : "OFF"}
          </span>
          {always && (
            <span className="text-[10px] opacity-50">always-grant</span>
          )}
          {session && !always && (
            <span className="text-[10px] opacity-50">session-grant</span>
          )}
        </div>
        <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">
          {description}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled || busy}
        onClick={() => onToggle(!on)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors",
          on ? "bg-emerald-600" : "bg-muted-foreground/30",
          (disabled || busy) && "cursor-not-allowed opacity-50",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform",
            on && "translate-x-5",
          )}
        />
      </button>
    </div>
  );
}

function PresetsPanel() {
  const [presets, setPresets] = useState<SpawnPresetDto[]>([]);
  const [orphans, setOrphans] = useState<
    Array<{ path: string; description?: string | null }>
  >([]);
  const [hint, setHint] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const caps = useMinimalStore((s) => s.capabilities);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await minimalFetch<{
        presets?: SpawnPresetDto[];
        orphans?: Array<{ path: string; description?: string | null }>;
        invoke_hint?: string;
      }>("/v1/spawn/presets", { token: getMinimalToken() });
      setPresets(res.presets ?? []);
      setOrphans(res.orphans ?? []);
      setHint(res.invoke_hint ?? "");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPresets([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="Spawn 预设（只读）">
        <p className="text-muted-foreground mb-3 text-[12px] leading-relaxed">
          主 Agent 通过{" "}
          <code className="text-[11px]">spawn_agent</code>（同步）或{" "}
          <code className="text-[11px]">spawn_background</code>
          （后台 job）拉起这些角色。工具与回合上限写在 preset /{" "}
          <code className="text-[11px]">agents/*.md</code>
          中；改配置后通常需重启 web 进程。
        </p>
        {hint && (
          <p className="text-muted-foreground mb-3 font-mono text-[11px] opacity-80">
            {hint}
          </p>
        )}

        {loading && <p className="text-[12px] opacity-60">加载中…</p>}
        {err && <p className="text-[12px] text-red-600">{err}</p>}
        {!loading && !err && presets.length === 0 && (
          <p className="text-[12px] opacity-60">
            当前没有已注册的 spawn_presets。
          </p>
        )}

        <ul className="flex flex-col gap-2">
          {presets.map((p) => {
            const expanded = open === p.name;
            const shellGap = p.needs_shell && caps && !caps.shell;
            const webGap = p.needs_web && caps && !caps.web;
            const chips = p.tools.slice(0, 6);
            const more = p.tools.length - chips.length;
            return (
              <li
                key={p.name}
                className="border-border/50 rounded-lg border bg-background/50 px-3 py-2.5"
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() =>
                    setOpen(expanded ? null : p.name)
                  }
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-semibold">
                      {p.name}
                    </span>
                    {p.needs_shell && (
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[10px]",
                          shellGap
                            ? "bg-amber-500/15 text-amber-900 dark:text-amber-100"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        shell
                      </span>
                    )}
                    {p.needs_web && (
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[10px]",
                          webGap
                            ? "bg-amber-500/15 text-amber-900 dark:text-amber-100"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        web
                      </span>
                    )}
                    {p.max_turns != null && (
                      <span className="text-[10px] opacity-50">
                        max_turns={p.max_turns}
                      </span>
                    )}
                  </div>
                  {p.description && (
                    <p className="text-muted-foreground mt-1 text-[12px] leading-snug">
                      {p.description}
                    </p>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {chips.map((t) => (
                      <span
                        key={t}
                        className="bg-muted/80 rounded px-1.5 py-0.5 font-mono text-[10px]"
                      >
                        {t}
                      </span>
                    ))}
                    {more > 0 && (
                      <span className="text-[10px] opacity-50">+{more}</span>
                    )}
                  </div>
                </button>
                {expanded && (
                  <div className="border-border/40 mt-2 space-y-1 border-t pt-2 font-mono text-[11px] leading-relaxed opacity-80">
                    {p.prompt_file && <div>prompt: {p.prompt_file}</div>}
                    {(p.api_profile || p.model) && (
                      <div>
                        llm: {p.api_profile ?? "inherit"}/
                        {p.model ?? "default"}
                      </div>
                    )}
                    <div className="break-all">
                      tools: {p.tools.length ? p.tools.join(", ") : "(none)"}
                    </div>
                    {(shellGap || webGap) && (
                      <div className="text-amber-800 dark:text-amber-200">
                        注意：当前进程
                        {shellGap ? " shell=off" : ""}
                        {webGap ? " web=off" : ""}
                        ，调用此 preset 可能失败（可到「权限」打开）。
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <button
          type="button"
          className="border-border/60 mt-3 rounded-full border px-3 py-1 text-[11px] hover:bg-muted/50"
          onClick={() => void load()}
        >
          刷新预设
        </button>
      </SectionCard>

      {orphans.length > 0 && (
        <SectionCard title="未注册 agents/*.md">
          <p className="text-muted-foreground mb-2 text-[12px]">
            磁盘上有 agent 文件但未写入{" "}
            <code className="text-[11px]">spawn_presets</code>
            ，不会出现在 spawn 工具参数里。
          </p>
          <ul className="space-y-1 text-[12px]">
            {orphans.map((o) => (
              <li key={o.path} className="font-mono text-[11px] opacity-80">
                {o.path}
                {o.description ? (
                  <span className="text-muted-foreground font-sans">
                    {" "}
                    · {o.description}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}

function PermissionsPanel() {
  const caps = useMinimalStore((s) => s.capabilities);
  const isRunning = useMinimalStore((s) => s.isRunning);
  const refreshCapabilities = useMinimalStore((s) => s.refreshCapabilities);
  const setCapability = useMinimalStore((s) => s.setCapability);
  const lastError = useMinimalStore((s) => s.lastError);
  const [busy, setBusy] = useState<"shell" | "web" | null>(null);
  const [localMsg, setLocalMsg] = useState<string | null>(null);

  useEffect(() => {
    void refreshCapabilities();
  }, [refreshCapabilities]);

  const hot = caps?.hot_toggle !== false;
  const canToggle = hot && !isRunning;

  const toggle = async (kind: "shell" | "web", next: boolean) => {
    if (next && kind === "shell") {
      const ok = window.confirm(
        "开启 shell 后，Agent 可执行 run_shell（命令行）。\n仅建议在受信本机 / 内网环境开启。\n\n确认打开？",
      );
      if (!ok) return;
    }
    if (next && kind === "web") {
      const ok = window.confirm(
        "开启 web 后，Agent 可 web_fetch / 相关网络工具。\n确认打开？",
      );
      if (!ok) return;
    }
    setBusy(kind);
    setLocalMsg(null);
    const r = await setCapability(kind, next);
    setBusy(null);
    if (!r.ok) setLocalMsg(r.message || "切换失败");
  };

  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="进程级能力">
        <p className="text-muted-foreground mb-3 text-[12px] leading-relaxed">
          对应 runtime 的 <code className="text-[11px]">allowShell</code> /{" "}
          <code className="text-[11px]">allowWeb</code>
          。启动参数 <code className="text-[11px]">--allow-shell</code> /{" "}
          <code className="text-[11px]">--allow-web</code> 或下方热切（进程级，非 per-session）。
          子 Agent 若预设需要 shell/web 而此处关闭，调用会失败或弹出 JIT 审批（Web 端 JIT
          暂无 overlay）。
        </p>

        {!caps ? (
          <p className="text-[12px] opacity-60">加载中…</p>
        ) : (
          <div className="flex flex-col gap-2">
            <CapToggle
              label="Shell (run_shell)"
              description="允许在工作区内执行命令行。高权限；多任务 / 代码修改常用。"
              on={caps.shell}
              always={caps.always_grants?.shell}
              session={caps.session_grants?.shell}
              disabled={!canToggle}
              busy={busy === "shell"}
              onToggle={(n) => void toggle("shell", n)}
            />
            <CapToggle
              label="Web (web_fetch / search)"
              description="允许出站网络读取。抓网页、查文档时需要。"
              on={caps.web}
              always={caps.always_grants?.web}
              session={caps.session_grants?.web}
              disabled={!canToggle}
              busy={busy === "web"}
              onToggle={(n) => void toggle("web", n)}
            />
          </div>
        )}

        <div className="text-muted-foreground mt-3 space-y-1 text-[11px] leading-relaxed">
          {isRunning && (
            <p className="text-amber-700 dark:text-amber-200">
              Agent 运行中，暂不可切换。请先中止。
            </p>
          )}
          {caps?.auth_open && (
            <p>当前 auth 开放（NO_AUTH）— 请仅在本机/内网使用。</p>
          )}
          {(localMsg || lastError) && (
            <p className="text-red-600">{localMsg || lastError}</p>
          )}
        </div>

        <button
          type="button"
          className="border-border/60 mt-3 rounded-full border px-3 py-1 text-[11px] hover:bg-muted/50"
          onClick={() => void refreshCapabilities()}
        >
          刷新权限状态
        </button>
      </SectionCard>

      <SectionCard title="说明">
        <ul className="text-muted-foreground list-inside list-disc space-y-1 text-[12px] leading-relaxed">
          <li>
            <strong className="text-foreground/90">启动时打开</strong>
            ：<code className="text-[11px]">npm run web -- --allow-shell --allow-web</code>
          </li>
          <li>
            <strong className="text-foreground/90">热切</strong>
            ：仅影响当前 web 进程，重启后回到启动参数默认值。
          </li>
          <li>
            <strong className="text-foreground/90">与 Profile 无关</strong>
            ：模型在聊天栏选；权限是能否调用工具，不是哪家 API。
          </li>
        </ul>
      </SectionCard>
    </div>
  );
}

function shortPath(p: string, max = 48): string {
  if (p.length <= max) return p;
  return `…${p.slice(-(max - 1))}`;
}

function WorkspacePanel() {
  const isRunning = useMinimalStore((s) => s.isRunning);
  const workspace = useMinimalStore((s) => s.workspace);
  const refreshWorkspace = useMinimalStore((s) => s.refreshWorkspace);
  const workspaceAllow = useMinimalStore((s) => s.workspaceAllow);
  const workspaceRevoke = useMinimalStore((s) => s.workspaceRevoke);
  const workspaceSetCwd = useMinimalStore((s) => s.workspaceSetCwd);
  const workspaceGoPrimary = useMinimalStore((s) => s.workspaceGoPrimary);
  const lastError = useMinimalStore((s) => s.lastError);

  const [path, setPath] = useState("");
  const [mode, setMode] = useState<"read_write" | "read_only">("read_write");
  const [withShell, setWithShell] = useState(false);
  const [withWeb, setWithWeb] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localMsg, setLocalMsg] = useState<string | null>(null);

  useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  const run = async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    setLocalMsg(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setLocalMsg(r.message ?? "failed");
    else setLocalMsg(null);
  };

  const disabled = isRunning || busy;
  const grants = workspace?.grants ?? [];
  const active = workspace?.active_cwd ?? "—";
  const primary = workspace?.primary ?? "—";

  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="当前工作区">
        <p className="text-muted-foreground mb-3 text-[12px] leading-relaxed">
          同 session 可切换 active_cwd；工具读写受 grants 约束。运行中不可改。
          临时只读区外路径仍可用聊天里的 path_escape 弹窗。
        </p>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[7rem_1fr]">
          <dt className="text-muted-foreground text-[11px]">active_cwd</dt>
          <dd className="font-mono text-[12px] break-all" title={active}>
            {active}
          </dd>
          <dt className="text-muted-foreground text-[11px]">primary</dt>
          <dd className="font-mono text-[12px] break-all" title={primary}>
            {primary}
          </dd>
          <dt className="text-muted-foreground text-[11px]">project</dt>
          <dd className="font-mono text-[12px]">
            {workspace
              ? `${workspace.project_name} (${workspace.project_id.slice(0, 8)}…)`
              : "—"}
          </dd>
          <dt className="text-muted-foreground text-[11px]">policy</dt>
          <dd className="font-mono text-[12px]">
            {workspace?.capability_policy ?? "—"} ·{" "}
            {workspace?.session_store ?? "—"}
          </dd>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled}
            className="border-border/60 rounded-full border px-3 py-1 text-[11px] hover:bg-muted/50 disabled:opacity-40"
            onClick={() => void refreshWorkspace()}
          >
            刷新
          </button>
          <button
            type="button"
            disabled={disabled || active === primary}
            className="border-border/60 rounded-full border px-3 py-1 text-[11px] hover:bg-muted/50 disabled:opacity-40"
            onClick={() => void run(() => workspaceGoPrimary())}
          >
            回到 primary
          </button>
        </div>
        {(localMsg || lastError) && (
          <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">
            {localMsg || lastError}
          </p>
        )}
        {isRunning && (
          <p className="text-muted-foreground mt-2 text-[11px]">
            Agent 运行中，暂不可切换 cwd 或改 grants。
          </p>
        )}
      </SectionCard>

      <SectionCard title="路径授权 (allow)">
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={path}
            disabled={disabled}
            placeholder="/abs/path 或相对当前 cwd"
            className="border-border/60 bg-background w-full rounded-lg border px-3 py-2 font-mono text-[12px] disabled:opacity-40"
            onChange={(e) => setPath(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3 text-[12px]">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="grant-mode"
                checked={mode === "read_write"}
                disabled={disabled}
                onChange={() => setMode("read_write")}
              />
              读写
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="grant-mode"
                checked={mode === "read_only"}
                disabled={disabled}
                onChange={() => setMode("read_only")}
              />
              只读
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={withShell}
                disabled={disabled}
                onChange={(e) => setWithShell(e.target.checked)}
              />
              +shell
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={withWeb}
                disabled={disabled}
                onChange={(e) => setWithWeb(e.target.checked)}
              />
              +web
            </label>
            <button
              type="button"
              disabled={disabled || !path.trim()}
              className="bg-primary text-primary-foreground ml-auto rounded-full px-3 py-1 text-[11px] font-medium disabled:opacity-40"
              onClick={() =>
                void run(async () => {
                  const r = await workspaceAllow({
                    path: path.trim(),
                    mode,
                    shell: withShell,
                    web: withWeb,
                  });
                  if (r.ok) setPath("");
                  return r;
                })
              }
            >
              允许路径
            </button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Grants">
        {grants.length === 0 ? (
          <p className="text-muted-foreground text-[12px]">暂无 grant 数据</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {grants.map((g) => {
              const isActive = g.root === workspace?.active_cwd;
              const isPrimary = g.root === workspace?.primary;
              return (
                <li
                  key={g.root}
                  className="border-border/50 rounded-lg border bg-background/60 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className="min-w-0 flex-1 font-mono text-[11px] break-all"
                      title={g.root}
                    >
                      {shortPath(g.root, 56)}
                    </span>
                    {isActive && (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-800 dark:text-emerald-200">
                        cwd
                      </span>
                    )}
                    {isPrimary && (
                      <span className="bg-muted rounded-full px-2 py-0.5 text-[10px]">
                        primary
                      </span>
                    )}
                    <span className="text-muted-foreground text-[10px]">
                      {g.mode}
                      {g.shell ? " · shell" : ""}
                      {g.web ? " · web" : ""}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      disabled={disabled || isActive}
                      className="border-border/60 rounded-full border px-2 py-0.5 text-[10px] hover:bg-muted/50 disabled:opacity-40"
                      onClick={() =>
                        void run(() => workspaceSetCwd(g.root))
                      }
                    >
                      设为 cwd
                    </button>
                    {!isPrimary && (
                      <button
                        type="button"
                        disabled={disabled}
                        className="border-border/60 rounded-full border px-2 py-0.5 text-[10px] text-red-700 hover:bg-red-500/10 disabled:opacity-40 dark:text-red-300"
                        onClick={() =>
                          void run(() => workspaceRevoke(g.root))
                        }
                      >
                        撤销
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function McpPanel() {
  const connection = useMinimalStore((s) => s.connection);
  const [status, setStatus] = useState<McpStatusDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const s = await minimalFetch<McpStatusDto>("/v1/mcp/status", {
        token: getMinimalToken(),
      });
      setStatus(s);
      setErr(null);
    } catch (e) {
      setStatus(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // re-fetch when WS comes back
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load only on connection change
  }, [connection]);

  const servers = status?.servers ?? [];
  const tools = status?.tools ?? [];
  const connectedN = servers.filter((s) => s.connected).length;
  const enabledN = servers.filter((s) => s.enabled).length;

  const authLabel = (a: string) => {
    if (a === "oauth_client_credentials") return "OAuth · client_credentials";
    if (a === "headers") return "静态 headers";
    return "无";
  };

  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="连接状态">
        <p className="text-muted-foreground mb-3 text-[12px] leading-relaxed">
          启动时按{" "}
          <code className="text-[11px]">agent.json → mcp_servers</code>{" "}
          连接一次；改配置后需重启 web 进程。密钥不会出现在此页。
        </p>
        {err && (
          <p className="mb-2 text-[12px] text-red-600 dark:text-red-400">
            拉取失败：{err}
          </p>
        )}
        {loading && !status ? (
          <p className="text-muted-foreground text-[12px]">加载中…</p>
        ) : servers.length === 0 ? (
          <p className="text-muted-foreground text-[12px]">
            未配置任何 MCP server。见下方教程或{" "}
            <code className="text-[11px]">agent.mcp.example.json</code>。
          </p>
        ) : (
          <>
            <p className="text-muted-foreground mb-2 text-[11px]">
              已配置 {servers.length} · enabled {enabledN} · 已连接 {connectedN}{" "}
              · 工具 {tools.length}
            </p>
            <ul className="flex flex-col gap-2">
              {servers.map((s) => (
                <li
                  key={s.name}
                  className="border-border/50 rounded-lg border bg-background/60 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium">{s.name}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-medium",
                        !s.enabled
                          ? "bg-muted text-muted-foreground"
                          : s.connected
                            ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200"
                            : "bg-amber-500/15 text-amber-900 dark:text-amber-100",
                      )}
                    >
                      {!s.enabled
                        ? "disabled"
                        : s.connected
                          ? "connected"
                          : "disconnected"}
                    </span>
                    {s.transport && (
                      <span className="text-muted-foreground font-mono text-[10px]">
                        {s.transport}
                      </span>
                    )}
                    <span className="text-muted-foreground text-[10px]">
                      {authLabel(s.auth)}
                    </span>
                    <span className="text-muted-foreground ml-auto text-[10px]">
                      {s.tool_count} tools
                    </span>
                  </div>
                  {s.endpoint && (
                    <p className="text-muted-foreground mt-1 truncate font-mono text-[11px]">
                      {s.endpoint}
                    </p>
                  )}
                  {s.error && (
                    <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                      {s.error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        <button
          type="button"
          className="border-border/60 mt-3 rounded-full border px-3 py-1 text-[11px] hover:bg-muted/50"
          onClick={() => void load()}
        >
          刷新状态
        </button>
        {status?.config_hint && (
          <p className="text-muted-foreground mt-2 text-[10px]">
            {status.config_hint}
          </p>
        )}
      </SectionCard>

      {tools.length > 0 && (
        <SectionCard title="已暴露工具">
          <p className="text-muted-foreground mb-2 text-[12px]">
            Agent 侧名称形如{" "}
            <code className="text-[11px]">mcp_&lt;server&gt;_&lt;tool&gt;</code>
            ；受 <code className="text-[11px]">mcp_policy</code> 过滤。
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {tools.map((t) => (
              <li
                key={t.apiName}
                className="font-mono text-[11px] leading-snug"
              >
                <span className="text-foreground/90">{t.apiName}</span>
                {t.description ? (
                  <span className="text-muted-foreground">
                    {" "}
                    — {t.description.slice(0, 80)}
                    {t.description.length > 80 ? "…" : ""}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {status?.policy && (
            <p className="text-muted-foreground mt-2 text-[10px]">
              policy allow: {(status.policy.allow ?? ["*"]).join(", ") || "—"}
              {(status.policy.deny?.length ?? 0) > 0
                ? ` · deny: ${status.policy.deny!.join(", ")}`
                : ""}
            </p>
          )}
        </SectionCard>
      )}

      <SectionCard title="配置教程">
        <ol className="text-muted-foreground list-inside list-decimal space-y-2 text-[12px] leading-relaxed">
          <li>
            复制{" "}
            <code className="text-[11px]">agent.mcp.example.json</code>{" "}
            中的 <code className="text-[11px]">mcp_servers</code>{" "}
            片段到项目根{" "}
            <code className="text-[11px]">agent.json</code>。
          </li>
          <li>
            <strong className="text-foreground/90">stdio</strong>
            ：设 <code className="text-[11px]">command</code> +{" "}
            <code className="text-[11px]">args</code>
            （如本地 filesystem server）。
          </li>
          <li>
            <strong className="text-foreground/90">远程 HTTP</strong>
            ：<code className="text-[11px]">transport: streamable-http</code>（或{" "}
            <code className="text-[11px]">sse</code>）+{" "}
            <code className="text-[11px]">url</code>。
          </li>
          <li>
            <strong className="text-foreground/90">鉴权</strong>
            ：静态{" "}
            <code className="text-[11px]">headers.Authorization</code>
            ，或{" "}
            <code className="text-[11px]">oauth.type: client_credentials</code>{" "}
            + <code className="text-[11px]">client_id_env</code> /{" "}
            <code className="text-[11px]">client_secret_env</code>
            （密钥写在 <code className="text-[11px]">.env</code>
            ，token 缓存于{" "}
            <code className="text-[11px]">$AGENT_HOME/mcp-oauth/</code>）。
          </li>
          <li>
            可选{" "}
            <code className="text-[11px]">mcp_policy.allow / deny</code>{" "}
            按工具名通配过滤（如{" "}
            <code className="text-[11px]">mcp_filesystem_*</code>）。
          </li>
          <li>
            保存后<strong className="text-foreground/90">重启</strong>{" "}
            <code className="text-[11px]">npm run web</code>
            ，回到本页点「刷新状态」确认 connected 与工具列表。
          </li>
          <li>
            TUI 可用 <code className="text-[11px]">/mcp list</code>{" "}
            对照；主 Agent 通过工具名{" "}
            <code className="text-[11px]">mcp_…</code> 调用。
          </li>
        </ol>
        <p className="text-muted-foreground mt-3 text-[11px] leading-relaxed">
          当前<strong className="text-foreground/90">不支持</strong>
          在 Settings 里在线改 MCP（避免把 secret 写进浏览器）。用户登录
          OAuth（authorization code）尚未接入，仅有机机{" "}
          <code className="text-[11px]">client_credentials</code>。
        </p>
      </SectionCard>
    </div>
  );
}

function OverviewPanel() {
  const connection = useMinimalStore((s) => s.connection);
  const sessionId = useMinimalStore((s) => s.sessionId);
  const isRunning = useMinimalStore((s) => s.isRunning);
  const profile = useMinimalStore((s) => s.profile);
  const model = useMinimalStore((s) => s.model);
  const armedWorkflow = useMinimalStore((s) => s.armedWorkflow);
  const loadedSkills = useMinimalStore((s) => s.loadedSkills);
  const jobs = useMinimalStore((s) => s.jobs);
  const refreshCatalog = useMinimalStore((s) => s.refreshCatalog);

  const [health, setHealth] = useState<HealthDto | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const h = await minimalFetch<HealthDto>("/health", {
          token: getMinimalToken(),
        });
        if (!cancelled) {
          setHealth(h);
          setHealthErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          setHealth(null);
          setHealthErr(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const jobRun = useMemo(
    () => jobs.filter((j) => j.status === "running" || j.status === "queued"),
    [jobs],
  );

  const caps = useMinimalStore((s) => s.capabilities);

  const rows: Array<{ k: string; v: string }> = [
    { k: "WS", v: connection },
    {
      k: "Health",
      v: healthErr
        ? `error · ${healthErr}`
        : health
          ? health.ok
            ? "ok"
            : "degraded"
          : "…",
    },
    {
      k: "Session",
      v: sessionId ? `${sessionId.slice(0, 22)}${sessionId.length > 22 ? "…" : ""}` : "—",
    },
    { k: "Running", v: isRunning || health?.running ? "yes" : "no" },
    { k: "Profile", v: profile || health?.profile || "—" },
    { k: "Model", v: model || health?.model || "—" },
    {
      k: "Shell / Web",
      v: caps
        ? `${caps.shell ? "shell on" : "shell off"} · ${caps.web ? "web on" : "web off"}`
        : health
          ? `${(health as { shell?: boolean }).shell ? "shell on" : "shell ?"} · ${(health as { web?: boolean }).web ? "web on" : "web ?"}`
          : "—",
    },
    { k: "Armed workflow", v: armedWorkflow || health?.armed_workflow || "—" },
    {
      k: "Skills (loaded)",
      v: loadedSkills.length ? loadedSkills.join(", ") : "—",
    },
    {
      k: "Jobs (active)",
      v: jobRun.length ? String(jobRun.length) : "0",
    },
    {
      k: "Auth",
      v: isMinimalAuthOptional()
        ? "optional (NO_AUTH)"
        : getMinimalToken()
          ? "token set"
          : "token missing",
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="运行时概览">
        <p className="text-muted-foreground mb-3 text-[12px] leading-relaxed">
          只读快照：来自 WebSocket 状态 +{" "}
          <code className="text-[11px]">GET /health</code>。模型 / Skills
          仍在聊天栏修改，这里不负责切换。
        </p>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[8rem_1fr]">
          {rows.map((r) => (
            <div key={r.k} className="contents">
              <dt className="text-muted-foreground text-[11px] font-medium">
                {r.k}
              </dt>
              <dd className="font-mono text-[12px] break-all">{r.v}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          className="border-border/60 mt-3 rounded-full border px-3 py-1 text-[11px] hover:bg-muted/50"
          onClick={() => {
            void refreshCatalog();
            void minimalFetch<HealthDto>("/health", {
              token: getMinimalToken(),
            })
              .then((h) => {
                setHealth(h);
                setHealthErr(null);
              })
              .catch((e) =>
                setHealthErr(e instanceof Error ? e.message : String(e)),
              );
          }}
        >
          刷新状态
        </button>
      </SectionCard>

      <SectionCard title="关于本页">
        <ul className="text-muted-foreground list-inside list-disc space-y-1 text-[12px] leading-relaxed">
          <li>
            <strong className="text-foreground/90">聊天栏</strong>
            ：Profile / Model / Skills — 高频操作，保持就近。
          </li>
          <li>
            <strong className="text-foreground/90">Settings</strong>
            ：权限、子 Agent、MCP 状态、短指南。
          </li>
          <li>
            危险或需重启的配置会单独标注；S0 不做在线改{" "}
            <code className="text-[11px]">agent.json</code>。
          </li>
        </ul>
      </SectionCard>
    </div>
  );
}

const SECTION_IDS: SectionId[] = [
  "overview",
  "permissions",
  "workspace",
  "presets",
  "mcp",
  "guides",
];

function sectionFromHash(): SectionId {
  if (typeof window === "undefined") return "overview";
  const h = window.location.hash.replace(/^#/, "");
  return (SECTION_IDS as string[]).includes(h) ? (h as SectionId) : "overview";
}

export function SettingsShell() {
  const [section, setSection] = useState<SectionId>("overview");

  useEffect(() => {
    setSection(sectionFromHash());
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (id: SectionId) => {
    setSection(id);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${id}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Left nav */}
      <nav className="border-border/60 flex w-52 shrink-0 flex-col border-r bg-muted/15">
        <div className="border-border/60 border-b px-3 py-3">
          <div className="text-sm font-semibold">Settings</div>
          <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
            策略与能力 · 非聊天配置
          </p>
        </div>
        <ul className="flex flex-1 flex-col gap-0.5 p-2">
          {NAV.map((item) => {
            const active = section === item.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => go(item.id)}
                  className={cn(
                    "w-full rounded-lg px-2.5 py-2 text-left transition",
                    active
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <div className="text-[13px] font-medium">{item.label}</div>
                  <div className="text-[10px] opacity-60">{item.hint}</div>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="border-border/60 border-t p-2">
          <Link
            href="/"
            className="text-muted-foreground hover:text-foreground block rounded-lg px-2.5 py-2 text-[12px] transition hover:bg-muted/50"
          >
            ← 返回聊天
          </Link>
        </div>
      </nav>

      {/* Content */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 py-5">
          <header>
            <h1 className="text-lg font-semibold tracking-tight">
              {NAV.find((n) => n.id === section)?.label ?? "Settings"}
            </h1>
            <p className="text-muted-foreground mt-1 text-[12px] leading-relaxed">
              模型与 Skills 请继续在聊天栏操作；此处为运行时策略与短指南。
            </p>
          </header>

          {section === "overview" && <OverviewPanel />}
          {section === "permissions" && <PermissionsPanel />}
          {section === "workspace" && <WorkspacePanel />}
          {section === "presets" && <PresetsPanel />}
          {section === "mcp" && <McpPanel />}
          {section === "guides" && (
            <GuidesPanel onNavigate={(id) => go(id)} />
          )}
        </div>
      </div>
    </div>
  );
}
