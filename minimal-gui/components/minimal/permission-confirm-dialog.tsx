"use client";

import { useMinimalStore } from "@/lib/minimal/store";

/**
 * JIT modal for path_escape (read outside cwd / grants).
 * Shell & web stay Settings-only — backend auto-denies those kinds here.
 */
export function PermissionConfirmDialog() {
  const pending = useMinimalStore((s) => s.permissionConfirm);
  const busy = useMinimalStore((s) => s.permissionConfirmBusy);
  const respond = useMinimalStore((s) => s.respondPermissionConfirm);

  if (!pending) return null;

  const isPath = pending.kind === "path_escape";
  const title = isPath ? "允许读取工作区外路径？" : `权限请求：${pending.kind}`;
  const subtitle = isPath
    ? "Agent 要读取当前 cwd / grant 之外的路径（只读）。写入仍受硬限制。"
    : "Shell / Web 请在 Settings → 权限 中开启。";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="perm-confirm-title"
    >
      <div className="border-border bg-background max-h-[min(80vh,32rem)] w-full max-w-md overflow-hidden rounded-xl border shadow-2xl">
        <div className="border-border/60 border-b px-4 py-3">
          <h2
            id="perm-confirm-title"
            className="text-sm font-semibold tracking-tight"
          >
            {title}
          </h2>
          <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
            {subtitle}
          </p>
        </div>

        <div className="max-h-[min(40vh,16rem)] overflow-y-auto px-4 py-3">
          <div className="mb-2 flex flex-wrap gap-1.5 text-[11px]">
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-amber-900 dark:text-amber-100">
              {pending.kind}
            </span>
          </div>
          <pre className="bg-muted/50 text-foreground/90 overflow-x-auto rounded-lg border border-border/50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {pending.reason}
          </pre>
        </div>

        <div className="border-border/60 flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
          <button
            type="button"
            disabled={busy}
            className="border-border hover:bg-muted rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
            onClick={() => void respond("deny")}
          >
            拒绝
          </button>
          {isPath && (
            <>
              <button
                type="button"
                disabled={busy}
                className="border-border hover:bg-muted rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
                onClick={() => void respond("once")}
                title="仅本次调用"
              >
                允许一次
              </button>
              <button
                type="button"
                disabled={busy}
                className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                onClick={() => void respond("session")}
                autoFocus
                title="本会话内同类路径逃逸可继续"
              >
                本会话允许
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
