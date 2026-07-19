"use client";

import type { AppendMessage } from "@assistant-ui/react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useEffect, useMemo, useState } from "react";

import { getMinimalToken } from "@/lib/minimal/client";
import {
  coalesceToolsIntoAssistants,
  convertMessage,
  textFromAppendContent,
} from "@/lib/minimal/convert";
import { useMinimalStore } from "@/lib/minimal/store";
import { connectMinimalWs } from "@/lib/minimal/ws";

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

  // Avoid SSR/client mismatch: token may live in localStorage / ?query only on client.
  const [tokenHint, setTokenHint] = useState(false);

  useEffect(() => {
    const token = getMinimalToken();
    setTokenHint(!token);
    if (token) {
      useMinimalStore.getState().setToken(token);
      connectMinimalWs(token);
    }
  }, []);

  // Merge tool rows into assistant content parts → single layer, less whitespace
  const displayMessages = useMemo(
    () => coalesceToolsIntoAssistants(messages),
    [messages],
  );

  const onNew = async (message: AppendMessage) => {
    const text = textFromAppendContent(
      message.content as { type: string; text?: string }[],
    );
    if (!text.trim()) {
      throw new Error("Only text messages are supported");
    }
    // /slash → POST /v1/command (sendTask routes slash too)
    await sendTask(text.trim());
  };

  const onCancel = async () => {
    await abort();
  };

  const runtime = useExternalStoreRuntime({
    messages: displayMessages,
    isRunning,
    onNew,
    onCancel,
    convertMessage,
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

  const spawnLine = useMemo(() => {
    const running = activeSpawns.filter((s) => s.status === "running");
    if (!running.length) return null;
    return running
      .map((s) => {
        const tip = s.lastTool
          ? `${s.preset}→${s.lastTool}`
          : s.preset;
        const pv = s.preview.trim().replace(/\s+/g, " ").slice(0, 72);
        return pv ? `⏳ ${tip}: ${pv}` : `⏳ spawn ${tip}`;
      })
      .join(" · ");
  }, [activeSpawns]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-dvh flex-col">
        {/* Thin status only — profile/model/skills live under the composer */}
        <div className="border-border/60 text-muted-foreground flex flex-wrap items-center gap-x-2 border-b px-3 py-1 text-[11px]">
          <span className="font-medium text-foreground/80">minimal</span>
          <span className="opacity-40">·</span>
          <span className="truncate">{banner}</span>
          {tokenHint && (
            <span className="text-red-500">
              请设置 NEXT_PUBLIC_MINIMAL_TOKEN 或 URL ?token=
            </span>
          )}
        </div>
        {spawnLine && (
          <div className="border-border/50 bg-amber-500/10 text-amber-950 dark:text-amber-100 border-b px-3 py-1 font-mono text-[11px] leading-snug">
            <span className="opacity-70">子 agent 运行中（与主时间线隔离）· </span>
            <span className="truncate">{spawnLine}</span>
          </div>
        )}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </AssistantRuntimeProvider>
  );
}
