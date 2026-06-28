import { hashResult } from './action-store.js';

export type LoopGuardMode = 'inject' | 'terminate' | 'off';

export interface LoopGuardConfig {
  enabled: boolean;
  mode: LoopGuardMode;
  /** Absolute safety ceiling when maxTurns is 0 (unlimited). */
  hardCeiling: number;
}

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
    case 'run_shell': {
      const out: Record<string, unknown> = { command: String(args.command ?? '').trim() };
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
    default:
      return args;
  }
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
    return this.forcedSummaryPending;
  }

  activateForcedSummary(): void {
    this.forcedSummaryPending = false;
    this.forcedSummaryActive = true;
  }

  clearForcedSummary(): void {
    this.forcedSummaryActive = false;
  }

  afterToolTurn(turn: number, records: ToolTurnRecord[]): LoopGuardDecision {
    const entries = turnEntries(records);
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

    if (!this.isEnabled()) {
      return { action: 'continue' };
    }

    if (this.repeatStreak >= 3 || (this.softNudgeSent && this.repeatStreak >= 2)) {
      return this.hardLoopDecision();
    }

    if (this.repeatStreak >= 2 && !this.softNudgeSent) {
      this.softNudgeSent = true;
      if (this.config.mode === 'terminate') {
        return this.hardLoopDecision();
      }
      return { action: 'soft_nudge', message: SOFT_NUDGE_MESSAGE };
    }

    return { action: 'continue' };
  }

  afterEmptyResponse(): LoopGuardDecision {
    this.emptyStreak++;
    if (!this.isEnabled()) {
      return { action: 'continue' };
    }
    if (this.emptyStreak >= 3) {
      return this.hardLoopDecision('empty responses');
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