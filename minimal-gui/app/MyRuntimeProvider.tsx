"use client";

import type { AppendMessage } from "@assistant-ui/react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useEffect, useMemo, useState } from "react";
import { Loader2Icon } from "lucide-react";

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
  textFromAppendContent,
} from "@/lib/minimal/convert";
import { useMinimalStore } from "@/lib/minimal/store";
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
  const armedWorkflow = useMinimalStore((s) => s.armedWorkflow);
  const model = useMinimalStore((s) => s.model);
  const lastError = useMinimalStore((s) => s.lastError);
  const activeSpawns = useMinimalStore((s) => s.activeSpawns);
  const jobs = useMinimalStore((s) => s.jobs);

  // Avoid SSR/client mismatch: token may live in localStorage / ?query only on client.
  const [tokenHint, setTokenHint] = useState(false);
  const [showAllMessages, setShowAllMessages] = useState(false);

  useEffect(() => {
    const token = getMinimalToken();
    const open = isMinimalAuthOptional() || Boolean(token);
    setTokenHint(!open);
    if (open) {
      if (token) useMinimalStore.getState().setToken(token);
      connectMinimalWs(token || undefined);
    }
  }, []);

  // Merge tool rows; optionally cap long sessions for DOM cost
  const { displayMessages, hiddenCount } = useMemo(() => {
    const coalesced = coalesceToolsIntoAssistants(messages);
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

  const banner = useMemo(() => {
    return [
      connection === "open" ? "WS connected" : `WS ${connection}`,
      sessionId ? `session ${sessionId.slice(0, 18)}…` : "no session",
      model ? `model ${model}` : null,
      armedWorkflow ? `armed ${armedWorkflow}` : null,
      lastError ? `err: ${lastError}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }, [connection, sessionId, model, armedWorkflow, lastError]);

  /**
   * Compact activity strip: fixed height, no streaming previews.
   * Multi-job token streams used to thrash this bar → layout jump + scroll shake.
   */
  const activityStrip = useMemo(() => {
    const spawnRun = activeSpawns.filter((s) => s.status === "running");
    const jobRun = jobs.filter(
      (j) => j.status === "running" || j.status === "queued",
    );
    if (!spawnRun.length && !jobRun.length) return null;

    const bits: string[] = [];
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
  }, [activeSpawns, jobs]);

  return (
    <TooltipProvider delayDuration={200}>
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="flex h-dvh flex-col">
          {/* Thin status only — profile/model/skills live under the composer */}
          <div className="border-border/60 text-muted-foreground flex h-7 shrink-0 flex-wrap items-center gap-x-2 overflow-hidden border-b px-3 text-[11px]">
            <span className="font-medium text-foreground/80">minimal</span>
            <span className="opacity-40">·</span>
            <span className="min-w-0 flex-1 truncate">{banner}</span>
            {tokenHint && (
              <span className="text-red-500">
                请设置 NEXT_PUBLIC_MINIMAL_TOKEN 或 URL ?token=
              </span>
            )}
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
