/** L3 hooks: MessageBridge and related adapters (IM / multi-UI reserved). */

export {
  buildUserTaskMessage,
  createMessageBridge,
  createThrottledAssistantEmitter,
  DEFAULT_TOKEN_THROTTLE_MS,
  type CreateMessageBridgeOptions,
  type MessageBridge,
  type MessageSink,
  type SessionMessage,
  type SessionMessageRole,
  type SessionMessageSource,
  type ThrottledAssistantEmitter,
  type ThrottledAssistantEmitterOptions,
} from './message-bridge.js';
