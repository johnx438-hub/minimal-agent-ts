/**
 * MessageBridge (L3 / MB-0): human-readable session message fan-out.
 * Orthogonal to RuntimeEvent / --json-events (structured telemetry).
 * Does not alter ReAct, pointerize, or compression semantics.
 */

export type SessionMessageRole = 'user' | 'assistant' | 'tool' | 'system_notice';

export type SessionMessageSource = 'main' | 'spawn' | 'job' | 'workflow' | 'system';

/** One human-oriented message (IM bubble / multi-UI stream). */
export interface SessionMessage {
  session_id: string;
  turn: number;
  role: SessionMessageRole;
  timestamp: number;

  /** Streaming assistant increment (may be throttled). */
  delta?: string;
  /** Final or non-streaming body; tool preview / notice text. */
  content?: string;

  tool_name?: string;
  call_id?: string;
  task_id?: string;
  /** Raw tool args JSON when available (shell command / write content fallback). */
  args?: string;

  source?: SessionMessageSource;
  /** spawn preset name or job_id for threading */
  source_id?: string;
}

export interface MessageSink {
  readonly name: string;
  /** Must not throw into the agent loop; bridge isolates errors. */
  onMessage(msg: SessionMessage): void | Promise<void>;
}

export interface MessageBridge {
  /** Register a sink; returns unsubscribe. */
  addSink(sink: MessageSink): () => void;
  /** Synchronous fan-out; sink promises are not awaited. */
  emit(msg: SessionMessage): void;
  /** Number of active sinks (tests / diagnostics). */
  sinkCount(): number;
}

export interface CreateMessageBridgeOptions {
  /** Called when a sink throws or rejects (default: no-op). */
  onSinkError?: (sinkName: string, err: unknown) => void;
}

/** Build a main-session user task message (H1 / runTask). */
export function buildUserTaskMessage(
  sessionId: string,
  content: string,
  opts?: {
    task_id?: string;
    timestamp?: number;
    source?: SessionMessageSource;
    source_id?: string;
  },
): SessionMessage {
  return {
    session_id: sessionId,
    turn: 0,
    role: 'user',
    content,
    timestamp: opts?.timestamp ?? Date.now(),
    task_id: opts?.task_id,
    source: opts?.source ?? 'main',
    source_id: opts?.source_id,
  };
}

/**
 * Create a multi-sink bridge. Zero sinks ⇒ emit is free.
 * Sink failures never propagate to the caller.
 */
export function createMessageBridge(opts?: CreateMessageBridgeOptions): MessageBridge {
  const sinks = new Map<string, MessageSink>();
  const onSinkError = opts?.onSinkError;

  function reportError(name: string, err: unknown): void {
    try {
      onSinkError?.(name, err);
    } catch {
      // swallow secondary errors from the error handler itself
    }
  }

  function deliver(sink: MessageSink, msg: SessionMessage): void {
    try {
      const result = sink.onMessage(msg);
      if (result != null && typeof (result as Promise<void>).then === 'function') {
        void (result as Promise<void>).catch((err) => reportError(sink.name, err));
      }
    } catch (err) {
      reportError(sink.name, err);
    }
  }

  return {
    addSink(sink: MessageSink): () => void {
      const name = sink.name.trim();
      if (!name) {
        throw new Error('MessageSink.name must be non-empty');
      }
      sinks.set(name, sink);
      return () => {
        sinks.delete(name);
      };
    },

    emit(msg: SessionMessage): void {
      if (sinks.size === 0) return;
      for (const sink of sinks.values()) {
        deliver(sink, msg);
      }
    },

    sinkCount(): number {
      return sinks.size;
    },
  };
}

/** Shared default for assistant token coalescing (MB-2 wiring). */
export const DEFAULT_TOKEN_THROTTLE_MS = 80;

export interface ThrottledAssistantEmitterOptions {
  /** Min interval between delta emits. Default {@link DEFAULT_TOKEN_THROTTLE_MS}. */
  intervalMs?: number;
  /** Also flush when buffered chars reach this size (0 = disabled). Default 0. */
  minChars?: number;
  /** Clock for tests. */
  now?: () => number;
  /** Timer APIs for tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

export interface ThrottledAssistantEmitter {
  /** Buffer a stream token; may emit a coalesced delta. */
  pushDelta(delta: string): void;
  /** Flush any buffer as delta (optional) then emit final content. */
  flushFinal(content: string): void;
  /** Drop buffer and cancel pending timer without emit. */
  dispose(): void;
}

type AssistantBase = Pick<SessionMessage, 'session_id' | 'turn'> &
  Partial<Pick<SessionMessage, 'task_id' | 'source' | 'source_id'>>;

/**
 * Coalesce high-frequency LLM tokens into throttled assistant deltas.
 * Default interval is on ({@link DEFAULT_TOKEN_THROTTLE_MS}).
 * Used by H2 when wiring runAgent token events — safe to unit-test in MB-0.
 */
export function createThrottledAssistantEmitter(
  bridge: MessageBridge,
  base: AssistantBase,
  opts?: ThrottledAssistantEmitterOptions,
): ThrottledAssistantEmitter {
  const intervalMs = Math.max(0, opts?.intervalMs ?? DEFAULT_TOKEN_THROTTLE_MS);
  const minChars = Math.max(0, opts?.minChars ?? 0);
  const now = opts?.now ?? Date.now;
  const setTimer = opts?.setTimer ?? setTimeout;
  const clearTimer = opts?.clearTimer ?? clearTimeout;

  let buffer = '';
  /** null = never emitted a delta yet (do not use 0 — valid clock origin). */
  let lastEmitAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearPending(): void {
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function emitDelta(text: string): void {
    if (!text) return;
    lastEmitAt = now();
    bridge.emit({
      session_id: base.session_id,
      turn: base.turn,
      role: 'assistant',
      timestamp: lastEmitAt,
      delta: text,
      task_id: base.task_id,
      source: base.source ?? 'main',
      source_id: base.source_id,
    });
  }

  function flushBuffer(): void {
    if (!buffer) return;
    const text = buffer;
    buffer = '';
    clearPending();
    emitDelta(text);
  }

  function scheduleFlush(): void {
    if (timer != null || intervalMs <= 0) return;
    const elapsed = lastEmitAt == null ? intervalMs : now() - lastEmitAt;
    const wait = Math.max(0, intervalMs - elapsed);
    timer = setTimer(() => {
      timer = null;
      if (!disposed) flushBuffer();
    }, wait);
  }

  return {
    pushDelta(delta: string): void {
      if (disposed || !delta) return;
      buffer += delta;

      if (intervalMs <= 0) {
        flushBuffer();
        return;
      }

      if (minChars > 0 && buffer.length >= minChars) {
        flushBuffer();
        return;
      }

      if (lastEmitAt == null || now() - lastEmitAt >= intervalMs) {
        flushBuffer();
        return;
      }
      scheduleFlush();
    },

    flushFinal(content: string): void {
      if (disposed) return;
      // Remaining stream chunks as one delta before the definitive content line.
      flushBuffer();
      bridge.emit({
        session_id: base.session_id,
        turn: base.turn,
        role: 'assistant',
        timestamp: now(),
        content,
        task_id: base.task_id,
        source: base.source ?? 'main',
        source_id: base.source_id,
      });
    },

    dispose(): void {
      disposed = true;
      buffer = '';
      clearPending();
    },
  };
}
