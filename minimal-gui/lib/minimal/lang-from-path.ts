/** Infer shiki language id from path / explicit override. */
const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  diff: "diff",
  patch: "diff",
  toml: "toml",
  sql: "sql",
  xml: "xml",
  svg: "xml",
};

export function languageFromPath(
  path?: string,
  explicit?: string,
): string | undefined {
  if (explicit?.trim()) return explicit.trim().toLowerCase();
  if (!path) return undefined;
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_LANG[ext];
}

export function languageLabel(lang?: string): string {
  if (!lang) return "plain";
  const labels: Record<string, string> = {
    typescript: "TypeScript",
    tsx: "TSX",
    javascript: "JavaScript",
    jsx: "JSX",
    json: "JSON",
    bash: "Bash",
    shell: "Shell",
    python: "Python",
    rust: "Rust",
    go: "Go",
    yaml: "YAML",
    css: "CSS",
    html: "HTML",
    markdown: "Markdown",
    diff: "diff",
  };
  return labels[lang] ?? lang;
}

/** Unified-diff-ish content? */
export function looksLikeDiff(text: string): boolean {
  if (!text.trim()) return false;
  if (text.includes("@@")) return true;
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length > 0);
  if (lines.length < 2) return false;
  let scored = 0;
  for (const l of lines) {
    if (l.startsWith("+") || l.startsWith("-") || l.startsWith("@@")) scored += 1;
  }
  return scored / lines.length > 0.3;
}
