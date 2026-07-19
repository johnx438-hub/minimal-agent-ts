"use client";

import { useMinimalStore } from "@/lib/minimal/store";

/**
 * Modal gate before workflow execution — same strict policy as TUI overlay:
 * no "always allow", must confirm or cancel each entry.
 */
export function WorkflowConfirmDialog() {
  const pending = useMinimalStore((s) => s.workflowConfirm);
  const busy = useMinimalStore((s) => s.workflowConfirmBusy);
  const respond = useMinimalStore((s) => s.respondWorkflowConfirm);

  if (!pending) return null;

  const summary =
    pending.summary?.trim() ||
    [
      `Workflow "${pending.workflow}" will run with:`,
      `  shell: ${pending.needs_shell ? "required" : "not required"}`,
      `  web:   ${pending.needs_web ? "required" : "not required"}`,
      ...(pending.roles?.length
        ? [
            "  roles:",
            ...pending.roles.map((r) => {
              const flags = [
                r.needs_shell ? "shell" : null,
                r.needs_web ? "web" : null,
              ]
                .filter(Boolean)
                .join(", ");
              return `    • ${r.name}: ${r.tools.join(", ") || "(none)"}${flags ? ` (${flags})` : ""}`;
            }),
          ]
        : []),
      "This confirmation cannot be skipped or remembered (workflow entry).",
    ].join("\n");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wf-confirm-title"
    >
      <div className="border-border bg-background max-h-[min(80vh,36rem)] w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl">
        <div className="border-border/60 border-b px-4 py-3">
          <h2
            id="wf-confirm-title"
            className="text-sm font-semibold tracking-tight"
          >
            确认运行 Workflow
          </h2>
          <p className="text-muted-foreground mt-0.5 text-[11px]">
            与 TUI 相同的硬闸门 · 不可「始终允许」
          </p>
        </div>

        <div className="max-h-[min(50vh,20rem)] overflow-y-auto px-4 py-3">
          <div className="mb-2 flex flex-wrap gap-1.5 text-[11px]">
            <span className="bg-muted rounded-full px-2 py-0.5 font-mono">
              {pending.workflow}
            </span>
            {pending.needs_shell && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-800 dark:text-amber-200">
                shell
              </span>
            )}
            {pending.needs_web && (
              <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-sky-800 dark:text-sky-200">
                web
              </span>
            )}
          </div>
          <pre className="bg-muted/50 text-foreground/90 overflow-x-auto rounded-lg border border-border/50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {summary}
          </pre>
        </div>

        <div className="border-border/60 flex items-center justify-end gap-2 border-t px-4 py-3">
          <button
            type="button"
            disabled={busy}
            className="border-border hover:bg-muted rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
            onClick={() => void respond(false)}
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            onClick={() => void respond(true)}
            autoFocus
          >
            运行 Workflow
          </button>
        </div>
      </div>
    </div>
  );
}
