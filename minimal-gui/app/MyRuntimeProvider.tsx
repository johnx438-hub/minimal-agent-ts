"use client";

import type { AppendMessage } from "@assistant-ui/react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2Icon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";

import {
  createPathInboxAttachmentAdapter,
  formatTaskWithAttachments,
  pathsFromAppendMessage,
} from "@/lib/minimal/attachment-adapter";
import {
  getMinimalToken,
  isMinimalAuthOptional,
} from "@/lib/minimal/client";
import {
  coalesceToolsIntoAssistants,
  convertMessage,
  ensureUniqueMessageIds,
  textFromAppendContent,
} from "@/lib/minimal/convert";
import { useTheme } from "@/components/minimal/theme-provider";
import { POST_RUN_CATALOG_MS } from "@/lib/minimal/post-run-sync";
import { useMinimalStore } from "@/lib/minimal/store";
import { deriveRunActivity } from "@/lib/minimal/run-phase";
import { connectMinimalWs } from "@/lib/minimal/ws";
import { TooltipProvider } from "@/components/ui/tooltip";

/** Cap visible history after coalesce (older messages stay on server). */
const MESSAGE_DISPLAY_CAP = 80;

export function MyRuntimeProvider({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const messages = useMinimalStore((s) => s.messages);
  const isRunning = useMinimalStore((s) => s.isRunning);
  const sendTask = useMinimalStore((s) => s.sendTask);
  const abort = useMinimalStore((s) => s.abort);
  const connection = useMinimalStore((s) => s.connection);
  const sessionId = useMinimalStore((s) => s.sessionId);
  const lastError = useMinimalStore((s) => s.lastError);
  const activeSpawns = useMinimalStore((s) => s.activeSpawns);
  const refreshSessionList = useMinimalStore((s) => s.refreshSessionList);
  const refreshWorkspace = useMinimalStore((s) => s.refreshWorkspace);
  const workspace = useMinimalStore((s) => s.workspace);
  const jobs = useMinimalStore((s) => s.jobs);
  const { theme, toggle: toggleTheme } = useTheme();

  // Avoid SSR/client mismatch: token may live in localStorage / ?query only on client.
  const [tokenHint, setTokenHint] = useState(false);
  const [showAllMessages, setShowAllMessages] = useState(false);
  const wasRunningRef = useRef(false);

  useEffect(() => {
    const token = getMinimalToken();
    const open = isMinimalAuthOptional() || Boolean(token);
    setTokenHint(!open);
    if (open) {
      if (token) useMinimalStore.getState().setToken(token);
      connectMinimalWs(token || undefined);
    }
  }, []);

  // After generation ends: sidebar catalog only — never loadHistory (chat body is live).
  useEffect(() => {
    if (isRunning) {
      wasRunningRef.current = true;
      return;
    }
    if (!wasRunningRef.current) return;
    wasRunningRef.current = false;
    const t = window.setTimeout(() => {
      void refreshSessionList();
    }, POST_RUN_CATALOG_MS);
    return () => window.clearTimeout(t);
  }, [isRunning, refreshSessionList]);

  // Merge tool rows; optionally cap long sessions for DOM cost
  const { displayMessages, hiddenCount } = useMemo(() => {
    const coalesced = ensureUniqueMessageIds(
      coalesceToolsIntoAssistants(messages),
    );
    if (showAllMessages || coalesced.length <= MESSAGE_DISPLAY_CAP) {
      return { displayMessages: coalesced, hiddenCount: 0 };
    }
    return {
      displayMessages: coalesced.slice(-MESSAGE_DISPLAY_CAP),
      hiddenCount: coalesced.length - MESSAGE_DISPLAY_CAP,
    };
  }, [messages, showAllMessages]);

  const attachmentAdapter = useMemo(
    () =>
      createPathInboxAttachmentAdapter({
        getSessionId: () => useMinimalStore.getState().sessionId,
        getToken: () =>
          useMinimalStore.getState().token || getMinimalToken(),
      }),
    [],
  );

  const onNew = async (message: AppendMessage) => {
    const text = textFromAppendContent(
      message.content as { type: string; text?: string }[],
    );
    const paths = pathsFromAppendMessage(
      message as {
        content?: readonly { type: string; data?: string }[];
        attachments?: readonly {
          content?: readonly { type: string; data?: string }[];
          name?: string;
          id?: string;
          type?: string;
          contentType?: string;
        }[];
      },
    );
    const task = formatTaskWithAttachments(text, paths);
    if (!task.trim()) {
      throw new Error("请输入文字或添加附件");
    }

    // Build chips for the thread (component layer already renders attachments)
    const attachments = paths.map((path, i) => {
      const fromMsg = (
        message.attachments as
          | Array<{ id?: string; name?: string; type?: string; contentType?: string }>
          | undefined
      )?.[i];
      const name =
        fromMsg?.name || path.split("/").pop() || path;
      const type: "image" | "document" | "file" =
        fromMsg?.type === "image" ||
        fromMsg?.type === "document" ||
        fromMsg?.type === "file"
          ? fromMsg.type
          : /\.(png|jpe?g|gif|webp)$/i.test(name)
            ? "image"
            : "file";
      return {
        id: fromMsg?.id || `att_${i}_${name}`,
        name,
        path,
        contentType: fromMsg?.contentType,
        type,
      };
    });

    // /slash → POST /v1/command (sendTask routes slash too)
    await sendTask(task, {
      displayContent: text.trim() || (attachments.length ? "（附件）" : ""),
      attachments: attachments.length ? attachments : undefined,
    });
  };

  // Composer pause (□) while running → same as former standalone 中止
  const onCancel = async () => {
    await abort();
  };

  const runtime = useExternalStoreRuntime({
    messages: displayMessages,
    isRunning,
    onNew,
    onCancel,
    convertMessage,
    adapters: {
      attachments: attachmentAdapter,
    },
  });

  // Ensure workspace snapshot after WS open (hello may already set it)
  useEffect(() => {
    if (connection === "open" && !workspace) {
      void refreshWorkspace();
    }
  }, [connection, workspace, refreshWorkspace]);

  /** Slim chrome: connection + session; cwd is a separate chip → Settings. */
  const banner = useMemo(() => {
    const ws =
      connection === "open"
        ? "●"
        : connection === "connecting"
          ? "◐"
          : "○";
    const sess = sessionId
      ? sessionId.length > 14
        ? `${sessionId.slice(0, 12)}…`
        : sessionId
      : "no session";
    const err = lastError ? ` · err: ${lastError}` : "";
    return `${ws} ${sess}${err}`;
  }, [connection, sessionId, lastError]);

  const cwdChip = useMemo(() => {
    const p = workspace?.active_cwd;
    if (!p) return "cwd …";
    const base = p.split("/").filter(Boolean).pop() ?? p;
    return base.length > 20 ? `cwd ${base.slice(0, 18)}…` : `cwd ${base}`;
  }, [workspace?.active_cwd]);

  /**
   * Background activity only (jobs/spawns). Main-run phase lives in
   * RunningStatusRow inside the thread — avoids double spinners / stale tools.
   */
  const activityStrip = useMemo(() => {
    const spawnRun = activeSpawns.filter((s) => s.status === "running");
    const jobRun = jobs.filter(
      (j) => j.status === "running" || j.status === "queued",
    );

    if (!spawnRun.length && !jobRun.length) {
      // No bg work: only show strip when main is running with a non-default phase
      // if we ever want dual display — currently keep strip free of main phase.
      return null;
    }

    const bits: string[] = [];
    // When main agent also running, prefix phase so strip still informative alone.
    if (isRunning) {
      const act = deriveRunActivity(messages, true);
      if (act.label) bits.push(act.label);
    }
    if (jobRun.length) {
      const names = jobRun
        .slice(0, 4)
        .map((j) => j.label || j.id.slice(0, 10))
        .join(" · ");
      bits.push(
        jobRun.length > 4
          ? `${jobRun.length} jobs: ${names}…`
          : `${jobRun.length} job${jobRun.length > 1 ? "s" : ""}: ${names}`,
      );
    }
    if (spawnRun.length) {
      const names = spawnRun
        .map((s) => (s.lastTool ? `${s.preset}→${s.lastTool}` : s.preset))
        .join(" · ");
      bits.push(
        spawnRun.length > 1 ? `spawn×${spawnRun.length}: ${names}` : `spawn: ${names}`,
      );
    }
    return bits.join("  |  ");
  }, [activeSpawns, jobs, isRunning, messages]);

  return (
    <TooltipProvider delayDuration={200}>
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="flex h-dvh flex-col">
          {/* Thin status only — profile/model/skills live under the composer */}
          <div className="border-border/60 text-muted-foreground flex h-7 shrink-0 items-center gap-x-2 overflow-hidden border-b px-3 text-[11px]">
            <Link
              href="/"
              className="text-foreground/80 shrink-0 font-medium hover:underline"
            >
              minimal
            </Link>
            <span className="opacity-40">·</span>
            <span
              className="min-w-0 flex-1 truncate"
              title={
                [
                  connection === "open" ? "WS connected" : `WS ${connection}`,
                  sessionId ?? "no session",
                  workspace?.active_cwd
                    ? `cwd ${workspace.active_cwd}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              }
            >
              {banner}
            </span>
            <Link
              href="/settings#workspace"
              className="text-muted-foreground hover:text-foreground hover:bg-muted/50 max-w-[9rem] shrink-0 truncate rounded-md px-1.5 py-0.5 font-mono text-[10px]"
              title={
                workspace
                  ? `active_cwd: ${workspace.active_cwd}\n点击打开 Settings → 工作区`
                  : "工作区 Settings"
              }
            >
              {cwdChip}
            </Link>
            {tokenHint && (
              <span className="shrink-0 text-red-500">
                请设置 NEXT_PUBLIC_MINIMAL_TOKEN 或 URL ?token=
              </span>
            )}
            <button
              type="button"
              onClick={() => toggleTheme()}
              className="text-muted-foreground hover:text-foreground hover:bg-muted/50 inline-flex size-6 shrink-0 items-center justify-center rounded-md"
              title={theme === "dark" ? "浅色模式" : "暗黑模式"}
              aria-label="切换主题"
            >
              {theme === "dark" ? (
                <SunIcon className="size-3.5" />
              ) : (
                <MoonIcon className="size-3.5" />
              )}
            </button>
            <Link
              href="/settings"
              className="text-muted-foreground hover:text-foreground hover:bg-muted/50 inline-flex size-6 shrink-0 items-center justify-center rounded-md"
              title="设置"
              aria-label="设置"
            >
              <SettingsIcon className="size-3.5" />
            </Link>
          </div>
          {/* Fixed single-line height — never wrap / resize (avoids viewport thrash) */}
          {activityStrip && (
            <div
              className="border-border/50 bg-amber-500/10 text-amber-950 dark:text-amber-100 flex h-8 shrink-0 items-center gap-2 overflow-hidden border-b px-3 font-mono text-[11px]"
              title={activityStrip}
            >
              <Loader2Icon className="size-3.5 shrink-0 animate-spin opacity-70" />
              <span className="min-w-0 flex-1 truncate">{activityStrip}</span>
            </div>
          )}
          {hiddenCount > 0 && (
            <div className="border-border/50 text-muted-foreground flex items-center gap-2 border-b px-3 py-1 text-[11px]">
              <span>已折叠更早 {hiddenCount} 条消息（显示最近 {MESSAGE_DISPLAY_CAP}）</span>
              <button
                type="button"
                className="text-foreground underline-offset-2 hover:underline"
                onClick={() => setShowAllMessages(true)}
              >
                显示全部
              </button>
            </div>
          )}
          {showAllMessages && messages.length > MESSAGE_DISPLAY_CAP && (
            <div className="border-border/50 text-muted-foreground flex items-center gap-2 border-b px-3 py-1 text-[11px]">
              <span>正在显示全部 {messages.length} 条</span>
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                onClick={() => setShowAllMessages(false)}
              >
                仅最近 {MESSAGE_DISPLAY_CAP}
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1">{children}</div>
        </div>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}
