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

export {
  attachToolDisplayForBridge,
  BridgeStepForwarder,
  DEFAULT_TOOL_BRIDGE_DISPLAY_CHARS,
  DEFAULT_TOOL_BRIDGE_SUMMARY_CHARS,
  MIN_BRIDGE_SUMMARY_CHARS,
  summarizeToolResultForBridge,
  type BridgeStepForwarderOptions,
  type ToolResultSummaryInput,
} from './bridge-step-forwarder.js';

export {
  SessionInboundQueue,
  type SessionInboundItem,
} from './session-inbound-queue.js';

export {
  DEFAULT_SESSION_NOTIFY,
  SYSTEM_EVENT_AUTO_RUN_INSTRUCTIONS,
  SYSTEM_EVENT_PROMPT_CLOSE,
  SYSTEM_EVENT_PROMPT_OPEN,
  clipDigest,
  createSystemEventHub,
  formatSystemEventForHumans,
  formatSystemEventSyntheticPrompt,
  getGlobalSystemEventHub,
  isSyntheticSystemEventPrompt,
  notifySystemEvent,
  resetSystemEventDedupeForTests,
  setGlobalSystemEventHub,
  systemEventToSessionMessage,
  type SessionNotifyConfig,
  type SystemEvent,
  type SystemEventHub,
  type SystemEventKind,
} from './system-event.js';

export { UNKNOWN_SESSION_ID } from './session-inbound-queue.js';
