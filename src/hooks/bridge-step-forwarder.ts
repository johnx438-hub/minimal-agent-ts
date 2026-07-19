/**
 * MB-2/MB-3: map AgentStepEvent → MessageBridge human stream.
 * - assistant: throttled token deltas + final
 * - tool: preview / truncated summary only (never expand cold storage)
 * Keeps lifecycle out of runner/agent cores; does not alter pointerize rules.
 */

import type { AgentStepEvent } from '../events.js';
import {
  createThrottledAssistantEmitter,
  type MessageBridge,
  type SessionMessageSource,
  type ThrottledAssistantEmitter,
  type ThrottledAssistantEmitterOptions,
} from './message-bridge.js';

/** Max chars for tool bridge body when falling back from full output. */
export const DEFAULT_TOOL_BRIDGE_SUMMARY_CHARS = 400;

/** Floor for summary clip length (avoid zero/negative maxChars). */
export const MIN_BRIDGE_SUMMARY_CHARS = 32;

/**
 * UI-only write/edit diff blocks (agent loop strips these via split*ToolOutput).
 * Cap keeps WS frames reasonable while still showing real code in Web tool cards.
 */
export const DEFAULT_TOOL_BRIDGE_DISPLAY_CHARS = 16_000;

const WRITE_DISPLAY_START = '\n[write_display]\n';
const WRITE_DISPLAY_END = '\n[/write_display]';
const EDIT_DISPLAY_START = '\n[edit_display]\n';
const EDIT_DISPLAY_END = '\n[/edit_display]';

export interface BridgeStepForwarderOptions {
  /** Default main session source. */
  source?: SessionMessageSource;
  source_id?: string;
  task_id?: string;
  /** Passed to createThrottledAssistantEmitter (default 80ms throttle). */
  throttle?: ThrottledAssistantEmitterOptions;
  /** Cap for tool_result summaries (default {@link DEFAULT_TOOL_BRIDGE_SUMMARY_CHARS}). */
  toolSummaryMaxChars?: number;
}

export interface ToolResultSummaryInput {
  name: string;
  output: string;
  preview?: string;
}

/**
 * Prefer live preview; else truncate output. Pointer cards stay compact as-is
 * when under 2× maxChars. Never loads ActionStore.
 */
export function summarizeToolResultForBridge(
  input: ToolResultSummaryInput,
  maxChars: number = DEFAULT_TOOL_BRIDGE_SUMMARY_CHARS,
): string {
  const limit = Math.max(MIN_BRIDGE_SUMMARY_CHARS, maxChars);
  const fromPreview = input.preview?.trim();
  if (fromPreview) {
    return clipBridgeText(fromPreview, limit);
  }

  const raw = (input.output ?? '').replace(/\r\n/g, '\n').trim();
  if (!raw) {
    return `(${input.name}: empty)`;
  }

  // Pointer cards are already human-sized; allow a bit more room.
  if (raw.startsWith('[action:')) {
    return clipBridgeText(raw, limit * 2);
  }

  return clipBridgeText(raw, limit);
}

function clipBridgeText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/**
 * Stateful forwarder: one throttled assistant emitter per turn + tool summaries.
 * Safe when bridge has zero sinks (emit is free).
 */
export class BridgeStepForwarder {
  private emitter: ThrottledAssistantEmitter | null = null;
  private activeTurn: number | null = null;

  constructor(
    private readonly bridge: MessageBridge,
    private readonly getSessionId: () => string | undefined,
    private readonly opts?: BridgeStepForwarderOptions,
  ) {}

  /** Forward relevant step events; ignore others. */
  onStep(event: AgentStepEvent): void {
    const sessionId = this.getSessionId();
    if (!sessionId) return;

    switch (event.type) {
      case 'turn_start':
        this.beginTurn(sessionId, event.turn);
        break;
      case 'token':
        this.ensureTurn(sessionId, event.turn);
        this.emitter?.pushDelta(event.delta);
        break;
      case 'final':
        this.finishTurn(sessionId, event.turn, event.text);
        break;
      case 'tool_result':
        this.emitToolResult(sessionId, event);
        break;
      default:
        break;
    }
  }

  /** Drop buffered tokens without emit (abort / run end). */
  dispose(): void {
    this.emitter?.dispose();
    this.emitter = null;
    this.activeTurn = null;
  }

  private beginTurn(sessionId: string, turn: number): void {
    this.emitter?.dispose();
    this.activeTurn = turn;
    this.emitter = createThrottledAssistantEmitter(
      this.bridge,
      {
        session_id: sessionId,
        turn,
        source: this.opts?.source ?? 'main',
        source_id: this.opts?.source_id,
        task_id: this.opts?.task_id,
      },
      this.opts?.throttle,
    );
  }

  private ensureTurn(sessionId: string, turn: number): void {
    if (this.emitter && this.activeTurn === turn) return;
    this.beginTurn(sessionId, turn);
  }

  private finishTurn(sessionId: string, turn: number, text: string): void {
    if (!this.emitter || this.activeTurn !== turn) {
      // Non-streaming path: no token events, emit final content only.
      this.bridge.emit({
        session_id: sessionId,
        turn,
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
        source: this.opts?.source ?? 'main',
        source_id: this.opts?.source_id,
        task_id: this.opts?.task_id,
      });
      this.emitter = null;
      this.activeTurn = null;
      return;
    }

    this.emitter.flushFinal(text);
    this.emitter = null;
    this.activeTurn = null;
  }

  private emitToolResult(
    sessionId: string,
    event: Extract<AgentStepEvent, { type: 'tool_result' }>,
  ): void {
    const maxChars = this.opts?.toolSummaryMaxChars ?? DEFAULT_TOOL_BRIDGE_SUMMARY_CHARS;
    const summary = summarizeToolResultForBridge(
      { name: event.name, output: event.output, preview: event.preview },
      maxChars,
    );
    // Re-attach UI display block so Web can show write/edit diffs (TUI already
    // receives display on the step event; the bridge used to drop it).
    const content = attachToolDisplayForBridge(
      event.name,
      summary,
      event.display,
      DEFAULT_TOOL_BRIDGE_DISPLAY_CHARS,
    );

    this.bridge.emit({
      session_id: sessionId,
      turn: event.turn,
      role: 'tool',
      content,
      timestamp: Date.now(),
      tool_name: event.name,
      call_id: event.call_id,
      source: this.opts?.source ?? 'main',
      source_id: this.opts?.source_id,
      task_id: this.opts?.task_id,
      // Shell command / write content recovery when display missing
      args: typeof event.args === 'string' ? event.args : undefined,
    });
  }
}

/** Re-wrap agent-facing summary + optional UI display for MessageBridge. */
export function attachToolDisplayForBridge(
  toolName: string,
  summary: string,
  display: string | undefined,
  maxDisplayChars: number = DEFAULT_TOOL_BRIDGE_DISPLAY_CHARS,
): string {
  const body = display?.trim();
  if (!body) return summary;

  const clipped =
    body.length > maxDisplayChars
      ? `${body.slice(0, maxDisplayChars)}\n… [display truncated]`
      : body;

  if (toolName === 'edit_file') {
    return `${summary}${EDIT_DISPLAY_START}${clipped}${EDIT_DISPLAY_END}`;
  }
  if (toolName === 'write_file' || toolName === 'apply_patch') {
    return `${summary}${WRITE_DISPLAY_START}${clipped}${WRITE_DISPLAY_END}`;
  }
  // Unknown tools with display: plain append under write markers (GUI still parses)
  return `${summary}${WRITE_DISPLAY_START}${clipped}${WRITE_DISPLAY_END}`;
}
