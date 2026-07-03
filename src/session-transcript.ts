import { existsSync, readFileSync, statSync } from 'node:fs';

import { extractCleanAnswer } from './summary.js';
import type { TaskBlock } from './task-tracker.js';
import type { TranscriptPolicy } from './plugins/types.js';
import type { ChatMessage } from './types.js';
import {
  getTranscriptPendingBytes,
  getTranscriptPendingRecords,
  getTranscriptWriteQueue,
} from './session-transcript-queue.js';
import { ensureSessionsDir, transcriptPath } from './workspace.js';

const TRANSCRIPT_VERSION = 1;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ASSISTANT_CHARS = 200_000;
const TOOL_PREVIEW_MAX = 120;

export interface TranscriptUserMessage {
  role: 'user';
  turn: number;
  content: string;
}

export interface TranscriptAssistantMessage {
  role: 'assistant';
  turn: number;
  content: string;
  has_tool_calls?: boolean;
}

export interface TranscriptToolMessage {
  role: 'tool';
  turn: number;
  action_id: string;
  tool_name: string;
  preview: string;
}

export type TranscriptMessage =
  | TranscriptUserMessage
  | TranscriptAssistantMessage
  | TranscriptToolMessage;

export interface TranscriptTaskRecord {
  v: typeof TRANSCRIPT_VERSION;
  kind: 'task';
  session_id: string;
  task_id: string;
  completed_at: number;
  turn_range: [number, number];
  messages: TranscriptMessage[];
}

export interface ResolvedTranscriptPolicy {
  enabled: boolean;
  maxBytesPerSession: number;
  maxAssistantCharsPerTask: number;
  includeToolStubs: boolean;
}

export function resolveTranscriptPolicy(
  policy?: TranscriptPolicy,
): ResolvedTranscriptPolicy {
  return {
    enabled: policy?.enabled !== false,
    maxBytesPerSession: policy?.max_bytes_per_session ?? DEFAULT_MAX_BYTES,
    maxAssistantCharsPerTask:
      policy?.max_assistant_chars_per_task ?? DEFAULT_MAX_ASSISTANT_CHARS,
    includeToolStubs: policy?.include_tool_stubs !== false,
  };
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function parseActionIdFromToolContent(content: string | null): string | undefined {
  if (!content) return undefined;
  const match = content.match(/\[action:([^\]]+)\]/);
  return match?.[1];
}

function toolPreview(
  content: string,
  toolName: string,
): { tool_name: string; preview: string } {
  const stripped = content.replace(/\[action:[^\]]+\]\n?/, '').trim();
  const preview = clip(stripped || content, TOOL_PREVIEW_MAX);
  return { tool_name: toolName || 'tool', preview };
}

function messageTurn(msg: ChatMessage, fallback: number): number {
  return typeof msg.turn === 'number' ? msg.turn : fallback;
}

function applyAssistantBudget(
  messages: TranscriptMessage[],
  maxChars: number,
): TranscriptMessage[] {
  let used = 0;
  return messages.map((m) => {
    if (m.role !== 'assistant') return m;
    const remaining = maxChars - used;
    if (remaining <= 0) {
      return { ...m, content: '…[truncated]' };
    }
    if (m.content.length <= remaining) {
      used += m.content.length;
      return m;
    }
    const clipped = `${m.content.slice(0, Math.max(0, remaining - 14))}…[truncated]`;
    used = maxChars;
    return { ...m, content: clipped };
  });
}

export function buildTranscriptTaskRecord(
  taskBlock: TaskBlock,
  policy: ResolvedTranscriptPolicy,
): TranscriptTaskRecord {
  const messages: TranscriptMessage[] = [];
  let toolIdx = 0;

  for (const msg of taskBlock.messages) {
    const turn = messageTurn(msg, taskBlock.turn_start);

    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content) {
        messages.push({ role: 'user', turn, content });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const raw = typeof msg.content === 'string' ? msg.content : '';
      const clean = extractCleanAnswer(raw);
      if (clean || (msg.tool_calls && msg.tool_calls.length > 0)) {
        messages.push({
          role: 'assistant',
          turn,
          content: clean,
          has_tool_calls: Boolean(msg.tool_calls && msg.tool_calls.length > 0),
        });
      }
      continue;
    }

    if (msg.role === 'tool' && policy.includeToolStubs) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const actionId = msg.action_id ?? parseActionIdFromToolContent(content);
      if (!actionId) continue;
      const toolName = taskBlock.tool_calls[toolIdx]?.name ?? 'tool';
      toolIdx += 1;
      const { tool_name, preview } = toolPreview(content, toolName);
      messages.push({
        role: 'tool',
        turn,
        action_id: actionId,
        tool_name,
        preview,
      });
    }
  }

  return {
    v: TRANSCRIPT_VERSION,
    kind: 'task',
    session_id: taskBlock.session_id,
    task_id: taskBlock.task_id,
    completed_at: Date.now(),
    turn_range: [taskBlock.turn_start, taskBlock.turn_end],
    messages: applyAssistantBudget(messages, policy.maxAssistantCharsPerTask),
  };
}

export function transcriptByteSize(sessionId: string): number {
  const path = transcriptPath(sessionId);
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function effectiveTranscriptByteSize(sessionId: string): number {
  return transcriptByteSize(sessionId) + getTranscriptPendingBytes(sessionId);
}

export function hasTranscript(sessionId: string): boolean {
  return effectiveTranscriptByteSize(sessionId) > 0;
}

export type AppendTranscriptResult =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'max_bytes' };

function estimateRecordBytes(record: TranscriptTaskRecord): number {
  return Buffer.byteLength(`${JSON.stringify(record)}\n`, 'utf8');
}

export function appendTaskTranscript(
  sessionId: string,
  taskBlock: TaskBlock,
  policyInput?: TranscriptPolicy,
): AppendTranscriptResult {
  const policy = resolveTranscriptPolicy(policyInput);
  if (!policy.enabled) return { ok: false, reason: 'disabled' };

  const record = buildTranscriptTaskRecord(taskBlock, policy);
  const recordBytes = estimateRecordBytes(record);

  if (effectiveTranscriptByteSize(sessionId) + recordBytes > policy.maxBytesPerSession) {
    return { ok: false, reason: 'max_bytes' };
  }

  getTranscriptWriteQueue().enqueue(sessionId, record);
  return { ok: true };
}

function readTranscriptLines(sessionId: string): string[] {
  const path = transcriptPath(sessionId);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseTranscriptLine(line: string): TranscriptTaskRecord | null {
  try {
    const parsed = JSON.parse(line) as TranscriptTaskRecord;
    return parsed.kind === 'task' ? parsed : null;
  } catch {
    return null;
  }
}

function mergedTranscriptRecords(sessionId: string): TranscriptTaskRecord[] {
  const byId = new Map<string, TranscriptTaskRecord>();
  for (const line of readTranscriptLines(sessionId)) {
    const parsed = parseTranscriptLine(line);
    if (parsed) byId.set(parsed.task_id, parsed);
  }
  for (const pending of getTranscriptPendingRecords(sessionId)) {
    byId.set(pending.task_id, pending);
  }
  return [...byId.values()];
}

export function readTranscriptTask(
  sessionId: string,
  taskId: string,
): TranscriptTaskRecord | null {
  for (const record of getTranscriptPendingRecords(sessionId)) {
    if (record.task_id === taskId) return record;
  }

  for (const line of readTranscriptLines(sessionId)) {
    const parsed = parseTranscriptLine(line);
    if (parsed && parsed.task_id === taskId) {
      return parsed;
    }
  }
  return null;
}

export function listTranscriptTaskRecords(sessionId: string): TranscriptTaskRecord[] {
  return mergedTranscriptRecords(sessionId);
}