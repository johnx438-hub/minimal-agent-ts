/**
 * Web-side pure shell display helpers (aligned with src/tui/pi/shell-display.ts).
 * Zero deps — keep in sync when TUI rules change.
 */

export function splitShellOutput(output: string): { meta?: string; body: string } {
  const flat = output.replace(/\r\n/g, "\n");
  const metaMatch = flat.match(/^\[shell:[^\]]+\]\n?/);
  if (!metaMatch) {
    return { body: flat.trim() };
  }
  const meta = metaMatch[0].trimEnd();
  const body = flat.slice(metaMatch[0].length).trim();
  return { meta, body: body || "(no output)" };
}

export function shellStatusFromOutput(output: string): string {
  const errMatch = output.match(/^error: exit (\d+)/m);
  const timeoutMatch = output.match(/^error: command timed out/m);
  const abortedMatch = output.match(/^error: command aborted/m);
  if (abortedMatch) return "aborted";
  if (timeoutMatch) return "timeout";
  if (errMatch) return `exit ${errMatch[1]}`;
  if (output.startsWith("error:")) return "error";
  return "ok";
}

export function compressCommandCwd(command: string, cwd?: string): string {
  if (!cwd || !command.includes(cwd)) return command;
  const normalized = cwd.replace(/\/+$/, "");
  if (normalized.length < 2) return command;
  let out = command.split(normalized + "/").join("");
  out = out.split(normalized).join(".");
  return out;
}

/** Try parse command from args JSON text ({"command":"..."}). */
export function commandFromArgsText(argsText?: string): string | undefined {
  if (!argsText?.trim()) return undefined;
  try {
    const o = JSON.parse(argsText) as { command?: string; command_b64?: string };
    if (typeof o.command === "string" && o.command.trim()) return o.command.trim();
    if (typeof o.command_b64 === "string" && o.command_b64.trim()) {
      try {
        if (typeof atob === "function") {
          return atob(o.command_b64.trim());
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

/**
 * Heuristic when no structured command: first non-empty line if it looks like a cmd.
 * Avoid treating log dumps as commands.
 */
export function commandHeuristicFromPreview(preview: string): string | undefined {
  const line = preview
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  if (line.startsWith("[shell:")) return undefined;
  if (line.startsWith("error:")) return undefined;
  if (line.length > 200) return undefined;
  // common: $ cmd, or bare npm/git/node
  if (line.startsWith("$ ")) return line.slice(2).trim();
  if (/^(npm|pnpm|yarn|bun|git|node|npx|tsx|python|pip|cargo|go|make|curl|echo|cd|ls|cat)\b/.test(line)) {
    return line;
  }
  return undefined;
}
