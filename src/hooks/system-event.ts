/**
 * SPEC_JOB_SESSION_NOTIFY: system events from job/workflow settle.
 * Bridge outbound + optional session inbound (auto_run).
 */

import type { MessageBridge, SessionMessage, SessionMessageSource } from './message-bridge.js';
import {
  SessionInboundQueue,
  type SessionInboundItem,
} from './session-inbound-queue.js';

export type SystemEventKind =
  | 'job_complete'
  | 'job_failed'
  | 'job_cancelled'
  | 'jobs_all_settled'
  | 'workflow_complete'
  | 'workflow_handback';

export interface SystemEvent {
  kind: SystemEventKind;
  timestamp: number;
  session_id: string;
  event_id: string;

  job_id?: string;
  preset?: string;
  status?: 'completed' | 'failed' | 'cancelled';
  ok?: boolean;
  summary_line?: string;
  report_path?: string;
  still_running?: number;
  still_running_ids?: string[];

  workflow?: string;
  workflow_path?: string;
  digest?: string;
  handback_reason?: string;
}

export interface SessionNotifyConfig {
  /** Emit MessageBridge system_notice (default true). */
  bridge?: boolean;
  /** Kick main agent when idle (default false). */
  auto_run?: boolean;
  /** Kinds that may auto_run (default: workflow + all_settled). */
  auto_run_kinds?: SystemEventKind[];
  /** per_event | debounce | settle_only */
  merge?: 'per_event' | 'debounce' | 'settle_only';
  debounce_ms?: number;
  max_digest_chars?: number;
}

export const DEFAULT_SESSION_NOTIFY: Required<
  Pick<
    SessionNotifyConfig,
    'bridge' | 'auto_run' | 'merge' | 'debounce_ms' | 'max_digest_chars'
  >
> & { auto_run_kinds: SystemEventKind[] } = {
  bridge: true,
  auto_run: false,
  auto_run_kinds: [
    'workflow_complete',
    'workflow_handback',
    'jobs_all_settled',
  ],
  merge: 'debounce',
  debounce_ms: 800,
  max_digest_chars: 4000,
};

/** Open/close markers for synthetic auto_run prompts (detect without false positives). */
export const SYSTEM_EVENT_PROMPT_OPEN = '<system_event not_user_message="true">';
export const SYSTEM_EVENT_PROMPT_CLOSE = '</system_event>';

const SUMMARY_LINE_CLIP = 500;
const STILL_RUNNING_IDS_LIST_MAX = 12;
const DEDUPE_SET_SOFT_CAP = 5000;
const DEDUPE_SET_TRIM_TO = 2000;

/** Instructions appended after system_event body for main-agent auto_run. */
export const SYSTEM_EVENT_AUTO_RUN_INSTRUCTIONS = [
  'You are the main agent. This is NOT a human user message.',
  'Review the job/workflow result: accept, suggest follow-ups, or ask the user what to do next.',
  'Do not re-arm a workflow unless the user already asked.',
  'Prefer not to fan out many new background jobs without confirmation.',
].join('\n');

/**
 * Detect harness-generated auto_run prompts.
 * Prefer `runTask(..., { skipArmedWorkflow: true })` for trusted paths;
 * string detection is a fallback and requires open marker at start + close + instruction line.
 */
export function isSyntheticSystemEventPrompt(prompt: string): boolean {
  const t = prompt.trimStart();
  if (!t.startsWith(SYSTEM_EVENT_PROMPT_OPEN)) return false;
  if (!t.includes(SYSTEM_EVENT_PROMPT_CLOSE)) return false;
  // Require our instruction block so casual user paste is less likely to match
  return t.includes('This is NOT a human user message');
}

export function clipDigest(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}…`;
}

/** Human + model shared body (not a user message). */
export function formatSystemEventForHumans(
  ev: SystemEvent,
  maxDigestChars = DEFAULT_SESSION_NOTIFY.max_digest_chars,
): string {
  const lines = [
    '[system_event · not a user message]',
    `kind: ${ev.kind}`,
  ];

  if (ev.job_id) {
    lines.push(`job_id: ${ev.job_id}`);
    if (ev.preset) lines.push(`preset: ${ev.preset}`);
    if (ev.status) {
      lines.push(
        `status: ${ev.status}${ev.ok !== undefined ? ` · ok=${ev.ok}` : ''}`,
      );
    }
    if (ev.summary_line) {
      lines.push(`summary: ${clipDigest(ev.summary_line, SUMMARY_LINE_CLIP)}`);
    }
    if (ev.report_path) lines.push(`report: ${ev.report_path}`);
    if (ev.still_running !== undefined) {
      lines.push(`still_running: ${ev.still_running}`);
      if (ev.still_running_ids?.length) {
        for (const id of ev.still_running_ids.slice(0, STILL_RUNNING_IDS_LIST_MAX)) {
          lines.push(`  - ${id}`);
        }
        if (ev.still_running_ids.length > STILL_RUNNING_IDS_LIST_MAX) {
          lines.push(
            `  - … +${ev.still_running_ids.length - STILL_RUNNING_IDS_LIST_MAX} more`,
          );
        }
      }
    }
  }

  if (ev.workflow) {
    lines.push(`workflow: ${ev.workflow}`);
    if (ev.workflow_path) lines.push(`path: ${ev.workflow_path}`);
    if (ev.handback_reason) lines.push(`handback_reason: ${ev.handback_reason}`);
    if (ev.digest) {
      lines.push('digest:', clipDigest(ev.digest, maxDigestChars));
    }
  }

  if (ev.kind === 'jobs_all_settled') {
    lines.push('message: All background jobs for this session have settled.');
  }

  return lines.join('\n');
}

/** Synthetic prompt for main-agent auto_run (SPEC §6.2). */
export function formatSystemEventSyntheticPrompt(
  events: SystemEvent[],
  maxDigestChars = DEFAULT_SESSION_NOTIFY.max_digest_chars,
): string {
  const bodies = events.map((ev) => formatSystemEventForHumans(ev, maxDigestChars));
  return [
    SYSTEM_EVENT_PROMPT_OPEN,
    bodies.join('\n\n---\n\n'),
    SYSTEM_EVENT_PROMPT_CLOSE,
    '',
    SYSTEM_EVENT_AUTO_RUN_INSTRUCTIONS,
  ].join('\n');
}

export function systemEventToSessionMessage(ev: SystemEvent): SessionMessage {
  let source: SessionMessageSource = 'system';
  if (ev.kind.startsWith('job')) source = 'job';
  else if (ev.kind.startsWith('workflow')) source = 'workflow';

  const source_id =
    ev.job_id ??
    (ev.workflow ? `workflow:${ev.workflow}` : undefined);

  return {
    session_id: ev.session_id,
    turn: 0,
    role: 'system_notice',
    timestamp: ev.timestamp,
    content: formatSystemEventForHumans(ev),
    source,
    source_id,
  };
}

export interface SystemEventHubOptions {
  bridge?: MessageBridge;
  config?: SessionNotifyConfig;
  /** Optional RuntimeEvent / telemetry sink */
  onEvent?: (ev: SystemEvent) => void;
  /** Called after enqueue when auto_run may apply */
  onMaybeAutoRun?: (sessionId: string) => void;
  inboundQueue?: SessionInboundQueue;
}

/**
 * Central notify: dedupe → bridge → inbound queue → callbacks.
 * Dedupe set is **per hub** (not process-global) so multi-runtime tests do not clash.
 */
export function createSystemEventHub(opts: SystemEventHubOptions = {}) {
  const inbound = opts.inboundQueue ?? new SessionInboundQueue();
  const seenEventIds = new Set<string>();
  let config: SessionNotifyConfig = {
    ...DEFAULT_SESSION_NOTIFY,
    ...opts.config,
  };
  let bridge = opts.bridge;
  let onEvent = opts.onEvent;
  let onMaybeAutoRun = opts.onMaybeAutoRun;

  function resolveConfig(): typeof DEFAULT_SESSION_NOTIFY & SessionNotifyConfig {
    return { ...DEFAULT_SESSION_NOTIFY, ...config };
  }

  function shouldAutoRun(kind: SystemEventKind): boolean {
    const c = resolveConfig();
    if (!c.auto_run) return false;
    if (c.merge === 'settle_only') {
      return (
        kind === 'jobs_all_settled' ||
        kind === 'workflow_complete' ||
        kind === 'workflow_handback'
      );
    }
    const kinds = c.auto_run_kinds ?? DEFAULT_SESSION_NOTIFY.auto_run_kinds;
    return (kinds as SystemEventKind[]).includes(kind);
  }

  function notify(ev: SystemEvent): boolean {
    if (seenEventIds.has(ev.event_id)) return false;
    seenEventIds.add(ev.event_id);
    if (seenEventIds.size > DEDUPE_SET_SOFT_CAP) {
      const drop = [...seenEventIds].slice(0, DEDUPE_SET_TRIM_TO);
      for (const id of drop) seenEventIds.delete(id);
    }

    const c = resolveConfig();
    if (c.bridge !== false && bridge) {
      bridge.emit(systemEventToSessionMessage(ev));
    }

    onEvent?.(ev);

    // Enqueue only when this kind should auto_run (master switch + kind/merge policy).
    if (shouldAutoRun(ev.kind)) {
      inbound.enqueue(ev.session_id, {
        event: ev,
        enqueued_at: Date.now(),
        auto_run: true,
      });
      onMaybeAutoRun?.(ev.session_id);
    }

    return true;
  }

  return {
    notify,
    inbound,
    clearDedupeForTests(): void {
      seenEventIds.clear();
    },
    setBridge(b: MessageBridge | undefined): void {
      bridge = b;
    },
    setConfig(patch: SessionNotifyConfig): void {
      config = { ...config, ...patch };
    },
    getConfig(): SessionNotifyConfig {
      return { ...resolveConfig() };
    },
    setOnEvent(fn: ((ev: SystemEvent) => void) | undefined): void {
      onEvent = fn;
    },
    setOnMaybeAutoRun(fn: ((sessionId: string) => void) | undefined): void {
      onMaybeAutoRun = fn;
    },
    formatSyntheticPrompt(items: SessionInboundItem[]): string {
      const c = resolveConfig();
      return formatSystemEventSyntheticPrompt(
        items.map((i) => i.event),
        c.max_digest_chars ?? DEFAULT_SESSION_NOTIFY.max_digest_chars,
      );
    },
  };
}

export type SystemEventHub = ReturnType<typeof createSystemEventHub>;

/** Process-wide hub used by JobRegistry (set by AgentRuntime). */
let globalHub: SystemEventHub | null = null;

export function setGlobalSystemEventHub(hub: SystemEventHub | null): void {
  globalHub = hub;
}

export function getGlobalSystemEventHub(): SystemEventHub | null {
  return globalHub;
}

export function notifySystemEvent(ev: SystemEvent): boolean {
  return globalHub?.notify(ev) ?? false;
}

/** Test helper: clear dedupe on the global hub only. */
export function resetSystemEventDedupeForTests(): void {
  globalHub?.clearDedupeForTests();
}
