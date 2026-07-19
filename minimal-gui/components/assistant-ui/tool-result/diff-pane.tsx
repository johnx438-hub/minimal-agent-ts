"use client";

import { cn } from "@/lib/utils";

export function DiffPane({
  code,
  className,
}: {
  code: string;
  className?: string;
}) {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  return (
    <pre
      className={cn(
        "aui-tool-fallback-result-content max-h-72 overflow-auto rounded-lg border p-2.5 font-mono text-[12px] leading-relaxed",
        "border-border/70 bg-muted/30",
        className,
      )}
    >
      {lines.map((line, i) => {
        let rowClass = "text-foreground/90";
        if (line.startsWith("@@")) {
          rowClass = "text-blue-600/90 dark:text-blue-300/80";
        } else if (line.startsWith("+") && !line.startsWith("+++")) {
          rowClass =
            "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          rowClass = "bg-red-500/10 text-red-800 dark:text-red-300";
        }
        return (
          <div key={i} className={cn("whitespace-pre-wrap break-all", rowClass)}>
            {line.length ? line : " "}
          </div>
        );
      })}
    </pre>
  );
}
