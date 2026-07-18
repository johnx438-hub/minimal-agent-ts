/**
 * MessageBridge sink → WebSocket hub (SPEC_WEB_UI W1).
 * Must not throw into the agent loop; must not call runTask.
 */

import type { MessageSink, SessionMessage } from '../hooks/message-bridge.js';
import type { WsHub } from './ws-hub.js';

export function createWsMessageSink(hub: WsHub, name = 'web-ui'): MessageSink {
  return {
    name,
    onMessage(msg: SessionMessage): void {
      hub.broadcast(msg);
    },
  };
}
