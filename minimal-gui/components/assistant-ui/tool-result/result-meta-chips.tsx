"use client";

import { cn } from "@/lib/utils";

export function StatusChip({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const fail =
    status !== "ok" &&
    (status.startsWith("exit") ||
      status === "error" ||
      status === "timeout" ||
      status === "aborted");
  const warn = status === "timeout" || status === "aborted";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
        fail && !warn && "bg-red-500/15 text-red-700 dark:text-red-300",
        warn && "bg-amber-500/15 text-amber-800 dark:text-amber-300",
        !fail && !warn && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        className,
      )}
    >
      <span aria-hidden>{fail ? (warn ? "!" : "✗") : "●"}</span>
      {status}
    </span>
  );
}

export function SoftChip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-muted-foreground inline-flex items-center rounded-md bg-muted/50 px-1.5 py-0.5 text-[10px]",
        className,
      )}
    >
      {children}
    </span>
  );
}
