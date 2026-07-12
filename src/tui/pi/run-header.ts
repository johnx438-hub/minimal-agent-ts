import type { RunStartLlmMeta } from '../../events.js';
import { formatRunStartLlmSummary } from '../../events.js';

export interface RunHeaderInput {
  sessionId: string;
  cwd: string;
  agentMd?: { path: string; chars: number; truncated: boolean };
  memory?: { profile_chars: number; requirements_chars: number; truncated: boolean };
  llm?: RunStartLlmMeta;
  verbose?: boolean;
}

/** Short session id for one-line banner (keep last 12 chars of id body). */
export function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 20) return sessionId;
  const bare = sessionId.replace(/^session_/, '');
  if (bare.length <= 12) return sessionId;
  return `session_…${bare.slice(-8)}`;
}

/**
 * Compact run header (TUI-A). One line by default; multi-line when verbose.
 */
export function formatRunStartLines(input: RunHeaderInput): string[] {
  const short = shortSessionId(input.sessionId);
  const model =
    input.llm?.model?.trim() ||
    (input.llm ? formatRunStartLlmSummary(input.llm).split(' ')[0] : '') ||
    'model?';
  const profile = input.llm?.profile?.trim();
  const modelTag = profile ? `${profile}/${input.llm?.model ?? model}` : model;

  const extras: string[] = [];
  if (input.agentMd) extras.push('Agent.md');
  if (input.memory && input.memory.profile_chars + input.memory.requirements_chars > 0) {
    extras.push('memory');
  }
  if (input.llm?.session_override) extras.push('override');

  const compact = `▶ run · ${short} · ${modelTag}${extras.length ? ` · ${extras.join('+')}` : ''}`;

  if (!input.verbose) {
    return [compact];
  }

  const lines = [compact, `  cwd: ${input.cwd}`];
  if (input.agentMd) {
    const trunc = input.agentMd.truncated ? ', truncated' : '';
    lines.push(`  📋 ${input.agentMd.path} (${input.agentMd.chars} chars${trunc})`);
  }
  if (input.memory) {
    const total = input.memory.profile_chars + input.memory.requirements_chars;
    const trunc = input.memory.truncated ? ', truncated' : '';
    lines.push(
      `  🧠 memory: profile ${input.memory.profile_chars} + requirements ${input.memory.requirements_chars} = ${total} chars${trunc}`,
    );
  }
  if (input.llm) {
    lines.push(`  🤖 llm: ${formatRunStartLlmSummary(input.llm)}`);
  }
  return lines;
}

/** Whether action_flush / turn_io should paint in compact mode. */
export function shouldShowIoMetric(opts: {
  verboseIo: boolean;
  pending?: number;
  flushMs?: number;
  /** Flush slower than this is always interesting (ms). */
  slowMs?: number;
}): boolean {
  if (opts.verboseIo) return true;
  if ((opts.pending ?? 0) > 0) return true;
  if ((opts.flushMs ?? 0) >= (opts.slowMs ?? 50)) return true;
  return false;
}
