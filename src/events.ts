/** Per-turn agent loop events (headless / TUI / --json-events). */
export type AgentStepEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'token'; turn: number; delta: string }
  | { type: 'llm_done'; turn: number; finishReason: string | null; usage?: object }
  | { type: 'tool_batch'; turn: number; total: number; parallel: number }
  | { type: 'tool_call'; turn: number; name: string; args: string }
  | { type: 'tool_result'; turn: number; name: string; output: string; preview?: string }
  | { type: 'compression'; turn: number; pruned?: number }
  | { type: 'draft_discarded'; turn: number; chars: number }
  | {
      type: 'loop_guard';
      turn: number;
      action: 'soft_nudge' | 'forced_summary' | 'terminate';
      reason?: string;
    }
  | { type: 'final'; turn: number; text: string };

/** Agent step events plus runtime lifecycle events (TUI / --json-events). */
export type RuntimeEvent =
  | AgentStepEvent
  | { type: 'run_start'; session_id: string; cwd: string }
  | { type: 'run_end'; reason: 'completed' | 'aborted' | 'error'; message?: string }
  | { type: 'session_saved'; session_id: string; task_count: number }
  | { type: 'runtime'; shell: boolean; web: boolean }
  | {
      type: 'workflow_step';
      phase: 'role' | 'loop';
      role: string;
      round?: number;
    }
  | {
      type: 'workflow_handback';
      workflow: string;
      reason: 'loop_guard' | 'max_rounds_exhausted' | 'turn_ceiling' | 'agent_stopped';
      detail: string;
      role?: string;
      round?: number;
    };

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

export function emitJsonEvent(event: RuntimeEvent): void {
  const line = JSON.stringify({ ts: Date.now(), event });
  process.stdout.write(`${line}\n`);
}