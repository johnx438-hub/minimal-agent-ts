/**
 * TUI MessageBridge sink — show system_notice (job/workflow settle) in chat.
 * SPEC_JOB_SESSION_NOTIFY: human-readable, not user messages.
 */

import type { MessageSink, SessionMessage } from '../../hooks/message-bridge.js';
import type { PiChatLog } from './chat-log.js';
import { piSemantic } from './themes.js';

export const TUI_BRIDGE_SINK_NAME = 'tui-chat';

/** Max body chars rendered in TUI (full text still on disk / bridge consumers). */
export const TUI_SYSTEM_NOTICE_MAX_CHARS = 2_500;

export function formatBridgeMessageForTui(
  msg: SessionMessage,
  maxChars = TUI_SYSTEM_NOTICE_MAX_CHARS,
): string | null {
  if (msg.role !== 'system_notice') return null;
  const body = (msg.content ?? '').trim();
  if (!body) return null;

  const src =
    msg.source === 'job'
      ? `job${msg.source_id ? ` ${msg.source_id}` : ''}`
      : msg.source === 'workflow'
        ? `workflow${msg.source_id ? ` ${msg.source_id}` : ''}`
        : msg.source ?? 'system';

  const clipped =
    body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
  return `📡 ${src}\n${clipped}`;
}

export interface CreateTuiBridgeSinkOptions {
  chat: PiChatLog;
  /** Called after append so status bar / focus can refresh. */
  onAfterAppend?: () => void;
  maxChars?: number;
}

/**
 * Sink for MessageBridge: only system_notice (job/workflow completion notices).
 * Other roles are handled by PiEventPresenter via RuntimeEvent / step stream.
 */
export function createTuiBridgeSink(opts: CreateTuiBridgeSinkOptions): MessageSink {
  const maxChars = opts.maxChars ?? TUI_SYSTEM_NOTICE_MAX_CHARS;
  return {
    name: TUI_BRIDGE_SINK_NAME,
    onMessage(msg: SessionMessage): void {
      const text = formatBridgeMessageForTui(msg, maxChars);
      if (!text) return;
      opts.chat.appendText(text, false, piSemantic.accent);
      opts.onAfterAppend?.();
    },
  };
}
