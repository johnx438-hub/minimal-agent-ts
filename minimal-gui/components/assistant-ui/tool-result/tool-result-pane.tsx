"use client";

import { cn } from "@/lib/utils";

import { ShellResultBody } from "./shell-result-body";
import { WriteResultBody } from "./write-result-body";

export type ToolSkin = "read" | "write" | "shell" | "spawn" | "generic";

export interface ToolResultPayload {
  preview?: string;
  skin?: ToolSkin;
  path?: string;
  language?: string;
  command?: string;
  exitCode?: number | null;
  fullText?: string;
  kind?: "code" | "diff" | "log" | "mixed";
  _expand?: boolean;
}

export function parseToolResultPayload(result: unknown): ToolResultPayload {
  if (result == null) return {};
  if (typeof result === "string") {
    return { preview: result };
  }
  if (typeof result === "object" && !Array.isArray(result)) {
    const o = result as Record<string, unknown>;
    return {
      preview: typeof o.preview === "string" ? o.preview : undefined,
      skin: o.skin as ToolSkin | undefined,
      path: typeof o.path === "string" ? o.path : undefined,
      language: typeof o.language === "string" ? o.language : undefined,
      command: typeof o.command === "string" ? o.command : undefined,
      exitCode:
        typeof o.exitCode === "number" || o.exitCode === null
          ? (o.exitCode as number | null)
          : undefined,
      fullText: typeof o.fullText === "string" ? o.fullText : undefined,
      kind: o.kind as ToolResultPayload["kind"],
      _expand: Boolean(o._expand),
    };
  }
  return { preview: String(result) };
}

function payloadText(payload: ToolResultPayload, raw: unknown): string {
  if (payload.fullText?.trim()) return payload.fullText;
  if (payload.preview != null && payload.preview !== "") return payload.preview;
  if (typeof raw === "string") return raw;
  // Never dump whole object as primary body when we already parsed fields
  if (payload.path || payload.command) return "";
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw ?? "");
  }
}

function ReadOrGenericBody({
  text,
  skin,
  className,
}: {
  text: string;
  skin: ToolSkin;
  className?: string;
}) {
  const box =
    skin === "read"
      ? "border-border/70 bg-muted/40 text-foreground/90"
      : skin === "spawn"
        ? "border-violet-500/25 bg-violet-500/5 text-foreground/90 max-h-48"
        : "border-border/60 bg-muted/50 text-foreground/90";
  return (
    <pre
      className={cn(
        "aui-tool-fallback-result-content max-h-72 overflow-auto rounded-lg border p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all",
        box,
        className,
      )}
    >
      {text || "(empty)"}
    </pre>
  );
}

export function ToolResultPane({
  skin,
  result,
  open = true,
  argsText,
  pathInTrigger,
  className,
}: {
  skin: ToolSkin;
  result: unknown;
  open?: boolean;
  argsText?: string;
  /** Trigger already shows path in title. */
  pathInTrigger?: boolean;
  className?: string;
}) {
  if (result === undefined || result === null || result === "") return null;

  const payload = parseToolResultPayload(result);
  const text = payloadText(payload, result);
  const effectiveSkin = payload.skin ?? skin;

  if (!text.trim() && effectiveSkin !== "shell") return null;

  return (
    <div
      data-slot="tool-fallback-result"
      className={cn("aui-tool-fallback-result", className)}
    >
      {effectiveSkin === "write" ? (
        <WriteResultBody
          text={text}
          path={payload.path}
          language={payload.language}
          kind={payload.kind}
          open={open}
          pathInTrigger={pathInTrigger ?? Boolean(payload.path)}
        />
      ) : effectiveSkin === "shell" ? (
        <ShellResultBody
          text={text}
          command={payload.command}
          argsText={argsText}
          open={open}
        />
      ) : effectiveSkin === "spawn" ? (
        <ReadOrGenericBody text={text} skin="spawn" />
      ) : (
        <ReadOrGenericBody text={text} skin={effectiveSkin} />
      )}
    </div>
  );
}
