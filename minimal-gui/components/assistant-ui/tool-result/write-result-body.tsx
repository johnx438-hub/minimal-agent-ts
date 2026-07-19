"use client";

import { FileIcon } from "lucide-react";

import {
  languageFromPath,
  languageLabel,
  looksLikeDiff,
} from "@/lib/minimal/lang-from-path";
import { cn } from "@/lib/utils";

import { CodePane, PlainPreview } from "./code-pane";
import { DiffPane } from "./diff-pane";
import { SoftChip } from "./result-meta-chips";

/** Drop leading path-only line if it duplicates meta path. */
function stripLeadingPathLine(body: string, path?: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  if (!lines.length) return body;
  const first = lines[0]!.trim();
  if (path && (first === path || first.endsWith(path))) {
    return lines.slice(1).join("\n").trim() || body;
  }
  if (first === "（路径见结果）" || first === "(no path)") {
    return lines.slice(1).join("\n").trim() || body;
  }
  return body;
}

export function WriteResultBody({
  text,
  path,
  language: languageProp,
  kind,
  open,
  pathInTrigger,
  className,
}: {
  text: string;
  path?: string;
  language?: string;
  kind?: "code" | "diff" | "log" | "mixed";
  open: boolean;
  /** Trigger already shows path — meta skips path label. */
  pathInTrigger?: boolean;
  className?: string;
}) {
  const body = stripLeadingPathLine(text, path);
  const lang = languageFromPath(path, languageProp);
  const asDiff = kind === "diff" || (kind !== "code" && looksLikeDiff(body));
  const lineCount = body.replace(/\r\n/g, "\n").split("\n").length;

  if (!open) {
    return <PlainPreview text={body} lines={3} className={className} />;
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[11px]">
        <FileIcon className="size-3.5 shrink-0 opacity-70" />
        {pathInTrigger && path ? null : (
          <span className="font-mono text-foreground/80">
            {path?.trim() || "（路径未提供）"}
          </span>
        )}
        <span className="opacity-40">·</span>
        <span>{asDiff ? "diff" : languageLabel(lang)}</span>
        <SoftChip>{lineCount} 行</SoftChip>
      </div>
      {asDiff ? (
        <DiffPane code={body} />
      ) : (
        <CodePane code={body} language={lang} open={open} />
      )}
    </div>
  );
}
