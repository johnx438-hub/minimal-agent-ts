/**
 * Lightweight fan-out for Web UI / TUI job panel updates.
 * Decoupled from RuntimeEvent so JobRegistry can publish without AgentRuntime.
 */

export interface JobUiUpdate {
  id: string;
  status: string;
  label?: string;
  parent_session_id?: string;
  stale?: boolean;
}

type Listener = (update: JobUiUpdate) => void;

const listeners = new Set<Listener>();

export function subscribeJobUi(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyJobUi(update: JobUiUpdate): void {
  for (const listener of listeners) {
    try {
      listener(update);
    } catch {
      // UI sinks must not break job lifecycle
    }
  }
}
