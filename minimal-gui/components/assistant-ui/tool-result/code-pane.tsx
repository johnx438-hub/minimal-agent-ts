"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { useTheme } from "@/components/minimal/theme-provider";
import { highlightCode } from "@/lib/minimal/shiki-singleton";
import { cn } from "@/lib/utils";

import { SoftChip } from "./result-meta-chips";

const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_CHARS = 8000;

function PlainMono({
  code,
  reason,
  className,
}: {
  code: string;
  reason?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      {reason && (
        <div className="mb-1 flex justify-end">
          <SoftChip>{reason}</SoftChip>
        </div>
      )}
      <pre
        className={cn(
          "aui-tool-fallback-result-content max-h-72 overflow-auto rounded-lg border p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all",
          "border-border/70 bg-muted/40 text-foreground/90",
        )}
      >
        {code}
      </pre>
    </div>
  );
}

export function CodePane({
  code,
  language,
  open = true,
  maxLines = DEFAULT_MAX_LINES,
  maxChars = DEFAULT_MAX_CHARS,
  copyable = true,
  className,
}: {
  code: string;
  language?: string;
  /** Collapsed: no shiki (V7). */
  open?: boolean;
  maxLines?: number;
  maxChars?: number;
  copyable?: boolean;
  className?: string;
}) {
  const { theme } = useTheme();
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const lineCount = useMemo(
    () => code.replace(/\r\n/g, "\n").split("\n").length,
    [code],
  );
  const tooLarge = code.length > maxChars || lineCount > maxLines;

  useEffect(() => {
    if (!open || tooLarge || !code) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    void highlightCode(code, language, theme === "light" ? "light" : "dark").then(
      (h) => {
        if (!cancelled) setHtml(h);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, tooLarge, code, language, theme]);

  const onCopy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  if (!open) {
    // Folded: optional tiny plain peek is owned by parent; zero shiki here.
    return null;
  }

  return (
    <div className={cn("relative", className)}>
      {copyable && (
        <button
          type="button"
          onClick={() => void onCopy()}
          className="bg-background/80 text-muted-foreground hover:text-foreground absolute top-2 right-2 z-10 inline-flex size-7 items-center justify-center rounded-md border border-border/60 backdrop-blur-sm"
          title="复制"
          aria-label="复制代码"
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-emerald-500" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </button>
      )}
      {tooLarge ? (
        <PlainMono code={code} reason="过大，未高亮" />
      ) : html ? (
        <div
          className={cn(
            "aui-tool-fallback-result-content aui-tool-code-shiki max-h-72 overflow-auto rounded-lg border border-border/70 text-[12px] leading-relaxed",
            "[&_pre]:m-0 [&_pre]:bg-transparent! [&_pre]:p-2.5 [&_pre]:font-mono",
            "[&_code]:font-mono [&_code]:text-[12px] [&_code]:leading-relaxed",
          )}
          // shiki-generated HTML only
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <PlainMono code={code} reason={language ? undefined : "plain"} />
      )}
    </div>
  );
}

export function PlainPreview({
  text,
  lines = 3,
  className,
}: {
  text: string;
  lines?: number;
  className?: string;
}) {
  const peek = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(0, lines)
    .join("\n");
  if (!peek.trim()) return null;
  return (
    <pre
      className={cn(
        "text-muted-foreground max-h-16 overflow-hidden font-mono text-[11px] leading-snug whitespace-pre-wrap opacity-80",
        className,
      )}
    >
      {peek}
      {text.split("\n").length > lines ? "\n…" : ""}
    </pre>
  );
}
