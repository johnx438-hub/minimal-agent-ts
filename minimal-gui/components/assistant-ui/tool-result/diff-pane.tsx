"use client";

import { cn } from "@/lib/utils";

export function DiffPane({
  code,
  className,
  showLineNumbers = true,
}: {
  code: string;
  className?: string;
  /** Soft gutter (1-based). Default on — review feedback asked for line numbers. */
  showLineNumbers?: boolean;
}) {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  const gutterW = String(Math.max(lines.length, 1)).length;
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
          <div
            key={i}
            className={cn(
              "flex whitespace-pre-wrap break-all",
              rowClass,
            )}
          >
            {showLineNumbers && (
              <span
                className="text-muted-foreground/50 shrink-0 select-none pe-3 text-right tabular-nums"
                style={{ minWidth: `${gutterW + 1}ch` }}
                aria-hidden
              >
                {i + 1}
              </span>
            )}
            <span className="min-w-0 flex-1">{line.length ? line : " "}</span>
          </div>
        );
      })}
    </pre>
  );
}
