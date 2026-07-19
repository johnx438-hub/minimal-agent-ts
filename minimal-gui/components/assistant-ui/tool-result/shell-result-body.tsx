"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon, TerminalIcon } from "lucide-react";

import {
  commandFromArgsText,
  commandHeuristicFromPreview,
  shellStatusFromOutput,
  splitShellOutput,
} from "@/lib/minimal/shell-display";
import { cn } from "@/lib/utils";

import { PlainPreview } from "./code-pane";
import { StatusChip } from "./result-meta-chips";

function isFailStatus(status: string): boolean {
  return (
    status !== "ok" &&
    (status.startsWith("exit") ||
      status === "error" ||
      status === "timeout" ||
      status === "aborted")
  );
}

export function ShellResultBody({
  text,
  command: commandProp,
  argsText,
  open,
  className,
}: {
  text: string;
  command?: string;
  argsText?: string;
  open: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const status = shellStatusFromOutput(text);
  const { body } = splitShellOutput(text);
  const command =
    commandProp?.trim() ||
    commandFromArgsText(argsText) ||
    commandHeuristicFromPreview(text) ||
    commandHeuristicFromPreview(body);

  const fail = isFailStatus(status);

  const onCopyCmd = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  if (!open) {
    return (
      <PlainPreview
        text={command ? `$ ${command}\n${body}` : body}
        lines={3}
        className={className}
      />
    );
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {command && (
        <div className="flex items-start gap-2">
          <TerminalIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
          <code className="text-foreground/90 min-w-0 flex-1 font-mono text-[12px] leading-snug break-all">
            <span className="text-muted-foreground select-none">$ </span>
            {command}
          </code>
          <button
            type="button"
            onClick={() => void onCopyCmd()}
            className="text-muted-foreground hover:text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-md"
            title="复制命令"
            aria-label="复制命令"
          >
            {copied ? (
              <CheckIcon className="size-3.5 text-emerald-500" />
            ) : (
              <CopyIcon className="size-3.5" />
            )}
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <StatusChip status={status} />
      </div>
      <pre
        className={cn(
          "aui-tool-fallback-result-content max-h-72 overflow-auto rounded-lg border p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all",
          fail
            ? "border-red-500/30 bg-red-500/5 text-foreground/90"
            : "border-amber-500/20 bg-amber-500/5 text-foreground/90",
        )}
      >
        {body || "(empty)"}
      </pre>
    </div>
  );
}
