"use client";

import { Thread } from "@/components/assistant-ui/thread";
import { ComposerChrome } from "@/components/minimal/composer-chrome";
import { MinimalSidebar } from "@/components/minimal/sidebar";
import { WorkflowConfirmDialog } from "@/components/minimal/workflow-confirm-dialog";
import { AuiProvider, Suggestions, useAui } from "@assistant-ui/react";

function ThreadWithSuggestions() {
  const aui = useAui({
    suggestions: Suggestions([
      {
        title: "Ping agent",
        label: "短确认",
        prompt: "请用一句话确认你在运行。",
      },
      {
        title: "/help",
        label: "命令说明",
        prompt: "/help",
      },
      {
        title: "/workflow",
        label: "工作流列表",
        prompt: "/workflow",
      },
      {
        title: "/skills",
        label: "技能列表",
        prompt: "/skills",
      },
    ]),
  });
  return (
    <AuiProvider value={aui}>
      <Thread />
    </AuiProvider>
  );
}

export default function Home() {
  return (
    <main className="flex h-full min-h-0">
      <MinimalSidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Thread owns sticky rounded composer; chrome sits under it */}
        <div className="min-h-0 flex-1">
          <ThreadWithSuggestions />
        </div>
        <ComposerChrome />
      </div>
      <WorkflowConfirmDialog />
    </main>
  );
}
