import { hashResult } from './action-store.js';
import { decodeShellCommand } from './tools/tool-args.js';
import type { ChatMessage } from './types.js';

export type LoopGuardMode = 'inject' | 'terminate' | 'off';

export interface LoopGuardConfig {
  enabled: boolean;
  mode: LoopGuardMode;
  /** Absolute safety ceiling when maxTurns is 0 (unlimited). */
  hardCeiling: number;
  /** Looser repeat detection for review/telemetry regression runs. */
  regressionMode?: boolean;
}

const REVIEW_DELEGATION_TOOLS = new Set(['code_review', 'spawn_agent', 'spawn_background']);

const REGRESSION_PATH_MARKERS = ['workspace/code-review-'];

export interface ToolTurnRecord {
  name: string;
  argsJson: string;
  output: string;
}

export type LoopGuardAction =
  | 'continue'
  | 'soft_nudge'
  | 'forced_summary'
  | 'terminate';

export interface LoopGuardDecision {
  action: LoopGuardAction;
  message?: string;
  reason?: string;
}

export const SOFT_NUDGE_MESSAGE =
  '[loop_guard] You repeated a tool with the same outcome. Try a different approach (another file, command, or strategy), or summarize progress so far.';

export const FORCED_SUMMARY_MESSAGE = `[loop_guard] Stop calling tools now.

Summarize what you have accomplished so far, what is still blocked, and list concrete next steps the user could take. Reply in plain text only — do not call any tools.`;

export const EMPTY_CONTINUE_NUDGE = 'Please continue or summarize what you found.';

export const FORCED_SUMMARY_RETRY_NUDGE =
  'Please provide a plain-text summary without calling tools.';

const LOOP_GUARD_INJECTIONS = new Set([
  SOFT_NUDGE_MESSAGE,
  FORCED_SUMMARY_MESSAGE,
  EMPTY_CONTINUE_NUDGE,
  FORCED_SUMMARY_RETRY_NUDGE,
]);

export function isLoopGuardInjection(message: ChatMessage): boolean {
  if (message.role !== 'user') return false;
  const content = typeof message.content === 'string' ? message.content : '';
  return LOOP_GUARD_INJECTIONS.has(content);
}

/**
 * Harness-only user rows: loop-guard nudges + malformed tool-args retries.
 * These must not surface as human chat in TUI/Web (LLM context only).
 */
export function isHarnessInjectedUserMessage(message: ChatMessage): boolean {
  if (message.role !== 'user') return false;
  if (isLoopGuardInjection(message)) return true;
  const content = typeof message.content === 'string' ? message.content : '';
  // Lazy import avoided: prefix match is stable and shared with tool-args.ts
  return content
    .trimStart()
    .startsWith('Your previous tool call arguments were invalid JSON');
}

export function stripLoopGuardInjections(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => !isHarnessInjectedUserMessage(m));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function normalizeArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case 'read_file': {
      const out: Record<string, unknown> = {};
      if (args.path !== undefined) out.path = String(args.path);
      if (args.offset !== undefined) out.offset = Number(args.offset);
      if (args.limit !== undefined) out.limit = Number(args.limit);
      return out;
    }
    case 'grep_search': {
      const out: Record<string, unknown> = { pattern: String(args.pattern ?? '') };
      if (args.path !== undefined) out.path = String(args.path);
      if (args.glob !== undefined) out.glob = String(args.glob);
      return out;
    }
    case 'recall_query': {
      const out: Record<string, unknown> = {};
      if (args.action_id !== undefined) out.action_id = String(args.action_id);
      if (args.query !== undefined) out.query = String(args.query);
      if (args.slice !== undefined) out.slice = String(args.slice);
      return out;
    }
    case 'list_files':
      return { path: String(args.path ?? '.'), max_depth: Number(args.max_depth ?? 3) };
    case 'diff_file':
      return {
        path: String(args.path ?? ''),
        before_action_id: String(args.before_action_id ?? ''),
      };
    case 'write_file':
      return { path: String(args.path ?? '') };
    case 'web_fetch':
      return { url: String(args.url ?? '').trim() };
    case 'web_search':
      return { query: String(args.query ?? '').trim() };
    case 'run_shell': {
      const decoded = decodeShellCommand(args);
      const out: Record<string, unknown> = {
        command: decoded.ok ? decoded.command : String(args.command ?? '').trim(),
      };
      if (args.working_dir !== undefined) out.working_dir = String(args.working_dir);
      if (args.auto_extend === true) out.auto_extend = true;
      if (args.timeout_ms !== undefined) out.timeout_ms = Number(args.timeout_ms);
      return out;
    }
    case 'invoke_skill': {
      const out: Record<string, unknown> = {};
      if (args.name !== undefined) out.name = String(args.name);
      if (args.query !== undefined) out.query = String(args.query);
      return out;
    }
    case 'code_review': {
      const out: Record<string, unknown> = {};
      if (args.scope !== undefined) out.scope = String(args.scope);
      if (args.focus !== undefined) out.focus = String(args.focus);
      if (args.background === true) out.background = true;
      return out;
    }
    case 'spawn_agent':
    case 'spawn_background': {
      const out: Record<string, unknown> = {};
      if (args.preset !== undefined) out.preset = String(args.preset);
      if (args.task !== undefined) {
        const task = String(args.task).trim();
        out.task = task.length > 120 ? `${task.slice(0, 120)}…` : task;
      }
      if (toolName === 'spawn_background' && args.wait === true) out.wait = true;
      return out;
    }
    default:
      return args;
  }
}

export function isRegressionTaskPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (/^\[regression\]/i.test(trimmed)) return true;
  if (/^regression\s*:/i.test(trimmed)) return true;
  // Env backdoor for integration harness only — never force all prompts in unit tests.
  if (process.env.NODE_ENV === 'test') return false;
  return process.env.LOOP_GUARD_REGRESSION === '1';
}

function isRegressionArtifactPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\//, '');
  return REGRESSION_PATH_MARKERS.some((marker) => normalized.includes(marker));
}

function isReviewDelegationTurn(records: ToolTurnRecord[]): boolean {
  return records.length > 0 && records.every((r) => REVIEW_DELEGATION_TOOLS.has(r.name));
}

function isRegressionSupportTurn(
  records: ToolTurnRecord[],
  regressionMode: boolean,
): boolean {
  if (!regressionMode || records.length === 0) return false;
  return records.every((r) => {
    if (REVIEW_DELEGATION_TOOLS.has(r.name)) return true;
    if (r.name === 'read_file' || r.name === 'list_files') {
      try {
        const args = JSON.parse(r.argsJson) as Record<string, unknown>;
        return isRegressionArtifactPath(String(args.path ?? ''));
      } catch {
        return false;
      }
    }
    return false;
  });
}

export function toolFingerprint(toolName: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const normalized = normalizeArgs(toolName, args);
    return hashResult(`${toolName}:${stableStringify(normalized)}`);
  } catch {
    return hashResult(`${toolName}:${argsJson}`);
  }
}

function turnEntries(records: ToolTurnRecord[]): Map<string, string> {
  const entries = new Map<string, string>();
  for (const record of records) {
    const fp = toolFingerprint(record.name, record.argsJson);
    entries.set(fp, hashResult(record.output));
  }
  return entries;
}

function isWriteProgress(records: ToolTurnRecord[]): boolean {
  return records.some(
    (r) => r.name === 'write_file' && r.output.trim().startsWith('ok: wrote'),
  );
}

function hasExplorationProgress(
  entries: Map<string, string>,
  seenFingerprints: Set<string>,
  seenResults: Map<string, string>,
): boolean {
  for (const [fp, resultHash] of entries) {
    if (!seenFingerprints.has(fp)) return true;
    if (seenResults.get(fp) !== resultHash) return true;
  }
  return false;
}

function countPrevMatches(
  current: Map<string, string>,
  previous: Map<string, string> | null,
): number {
  if (!previous) return 0;
  let matches = 0;
  for (const [fp, hash] of current) {
    if (previous.get(fp) === hash) matches++;
  }
  return matches;
}

export function resolveTurnCeiling(maxTurns: number, hardCeiling: number): number {
  if (maxTurns > 0) return maxTurns;
  return hardCeiling;
}

export function parseLoopGuardMode(raw: string | undefined): LoopGuardMode {
  const v = raw?.trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return 'off';
  if (v === 'terminate') return 'terminate';
  return 'inject';
}

export class LoopGuard {
  private repeatStreak = 0;
  private softNudgeSent = false;
  private emptyStreak = 0;
  private lastTurnEntries: Map<string, string> | null = null;
  private seenFingerprints = new Set<string>();
  private seenResults = new Map<string, string>();
  forcedSummaryPending = false;
  forcedSummaryActive = false;

  constructor(private readonly config: LoopGuardConfig) {}

  isEnabled(): boolean {
    return this.config.enabled && this.config.mode !== 'off';
  }

  shouldForceSummaryTurn(): boolean {
    return this.forcedSummaryPending || this.forcedSummaryActive;
  }

  activateForcedSummary(): void {
    this.forcedSummaryPending = false;
    this.forcedSummaryActive = true;
  }

  clearForcedSummary(): void {
    this.forcedSummaryActive = false;
  }

  private repeatHardThreshold(): number {
    return this.config.regressionMode ? 5 : 3;
  }

  private repeatSoftThreshold(): number {
    return this.config.regressionMode ? 4 : 2;
  }

  private noteTurnEntries(entries: Map<string, string>): void {
    for (const [fp, resultHash] of entries) {
      this.seenFingerprints.add(fp);
      this.seenResults.set(fp, resultHash);
    }
    this.lastTurnEntries = entries;
  }

  afterToolTurn(turn: number, records: ToolTurnRecord[]): LoopGuardDecision {
    if (!this.isEnabled()) {
      return { action: 'continue' };
    }

    const entries = turnEntries(records);

    if (
      isReviewDelegationTurn(records) ||
      isRegressionSupportTurn(records, Boolean(this.config.regressionMode))
    ) {
      this.noteTurnEntries(entries);
      this.repeatStreak = 0;
      this.softNudgeSent = false;
      return { action: 'continue' };
    }

    const progress =
      isWriteProgress(records) ||
      hasExplorationProgress(entries, this.seenFingerprints, this.seenResults);

    for (const [fp, resultHash] of entries) {
      this.seenFingerprints.add(fp);
      this.seenResults.set(fp, resultHash);
    }

    if (progress) {
      this.repeatStreak = 0;
      this.softNudgeSent = false;
    } else {
      const matches = countPrevMatches(entries, this.lastTurnEntries);
      if (matches > 0 && entries.size > 0) {
        this.repeatStreak++;
      } else {
        this.repeatStreak = 0;
      }
    }

    this.lastTurnEntries = entries;

    const hardAt = this.repeatHardThreshold();
    const softAt = this.repeatSoftThreshold();

    if (this.repeatStreak >= hardAt || (this.softNudgeSent && this.repeatStreak >= softAt)) {
      return this.hardLoopDecision();
    }

    if (this.repeatStreak >= softAt && !this.softNudgeSent) {
      this.softNudgeSent = true;
      if (this.config.mode === 'terminate') {
        return this.hardLoopDecision();
      }
      return { action: 'soft_nudge', message: SOFT_NUDGE_MESSAGE };
    }

    return { action: 'continue' };
  }

  afterEmptyResponse(): LoopGuardDecision {
    if (!this.isEnabled()) {
      return { action: 'continue' };
    }
    this.emptyStreak++;
    if (this.emptyStreak >= 3) {
      return {
        action: 'terminate',
        reason: 'loop_guard: empty responses',
      };
    }
    return { action: 'continue' };
  }

  afterTextResponse(): void {
    this.emptyStreak = 0;
    this.repeatStreak = 0;
    this.softNudgeSent = false;
    this.clearForcedSummary();
  }

  onForcedSummaryViolation(): LoopGuardDecision {
    return {
      action: 'terminate',
      reason: 'loop_guard: model called tools during forced summary',
    };
  }

  private hardLoopDecision(extraReason?: string): LoopGuardDecision {
    const reason = extraReason
      ? `loop_guard: ${extraReason}`
      : 'loop_guard: repeated tool calls with no progress';

    if (this.config.mode === 'terminate') {
      return { action: 'terminate', reason };
    }

    this.forcedSummaryPending = true;
    return { action: 'forced_summary', message: FORCED_SUMMARY_MESSAGE, reason };
  }
}