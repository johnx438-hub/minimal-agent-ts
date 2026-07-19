/**
 * Derive spinner / activity label while agent is running.
 * Tool bridge only emits results (complete) — after a tool lands we are
 * waiting on the model, not still executing that tool.
 */

import type { MinimalMessage } from "./types";
import { formatToolLiveLabel } from "./tool-tiers";
import { inferToolPath } from "./tool-parse";

export type RunPhase = "idle" | "tool" | "thinking" | "streaming";

export interface RunActivity {
  phase: RunPhase;
  /** Short status line for spinner / strip (null when idle). */
  label: string | null;
}

function toolPath(m: MinimalMessage): string | undefined {
  return (
    inferToolPath(m.content) ||
    inferToolPath(m.argsJson) ||
    m.content?.match(/(?:path[=:]\s*|to\s+)(\S+\.\w+)/i)?.[1] ||
    undefined
  );
}

/**
 * @param messages live store messages (not coalesced)
 * @param isRunning store / runtime flag
 */
export function deriveRunActivity(
  messages: MinimalMessage[],
  isRunning: boolean,
): RunActivity {
  if (!isRunning) return { phase: "idle", label: null };

  // True in-flight tool (status still running) — rare today; ready for tool_start.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool" && m.status === "running") {
      return {
        phase: "tool",
        label: formatToolLiveLabel(m.toolName, m.content, toolPath(m)),
      };
    }
  }

  // Streaming assistant (token deltas) — ignore trailing complete tools.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool") continue;
    if (m.role === "assistant") {
      const streaming =
        m.status === "running" ||
        Boolean(m.contentChunks?.length && m.status !== "complete");
      if (streaming) {
        return { phase: "streaming", label: "running" };
      }
      break;
    }
    if (m.role === "user" || m.role === "system") break;
  }

  // Waiting on API / between tools / after tool_result before next tokens.
  return { phase: "thinking", label: "thinking" };
}
