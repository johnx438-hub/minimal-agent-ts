/**
 * Lazy shiki highlighter singleton (dynamic import only).
 * Explicit lang subset — avoid full language pack.
 */

import type { Highlighter } from "shiki";

const LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "bash",
  "shellscript",
  "diff",
  "python",
  "yaml",
  "css",
  "html",
  "markdown",
  "rust",
  "go",
  "toml",
  "sql",
  "xml",
] as const;

let highlighterPromise: Promise<Highlighter> | null = null;

export function getShikiHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({
        themes: ["github-dark-default", "github-light-default"],
        langs: [...LANGS],
      }),
    );
  }
  return highlighterPromise;
}

/** Map our lang ids to shiki-loaded ids. */
export function resolveShikiLang(lang?: string): string | undefined {
  if (!lang) return undefined;
  const n = lang.toLowerCase();
  if (n === "bash" || n === "sh" || n === "zsh" || n === "shell") {
    return "bash";
  }
  if ((LANGS as readonly string[]).includes(n)) return n;
  return undefined;
}

export async function highlightCode(
  code: string,
  lang: string | undefined,
  theme: "dark" | "light",
): Promise<string | null> {
  try {
    const hl = await getShikiHighlighter();
    const resolved = resolveShikiLang(lang);
    const themeName =
      theme === "dark" ? "github-dark-default" : "github-light-default";
    if (!resolved || !hl.getLoadedLanguages().includes(resolved)) {
      return null;
    }
    return hl.codeToHtml(code, { lang: resolved, theme: themeName });
  } catch {
    return null;
  }
}
