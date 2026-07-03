import { appendFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';

import type { TranscriptTaskRecord } from './session-transcript.js';
import { ensureSessionsDir, transcriptPath } from './workspace.js';

const DEFAULT_DRAIN_MS = 100;

export interface TranscriptFlushInfo {
  flush_ms: number;
  count: number;
  pending: number;
}

export interface TranscriptWriteQueueOptions {
  drainIntervalMs?: number;
  sync?: boolean;
}

interface QueuedTranscriptLine {
  sessionId: string;
  record: TranscriptTaskRecord;
  line: string;
  bytes: number;
}

export class TranscriptWriteQueue {
  private readonly drainIntervalMs: number;
  private readonly sync: boolean;
  private readonly pending: QueuedTranscriptLine[] = [];
  private readonly pendingBytesBySession = new Map<string, number>();
  private readonly pendingRecordsBySession = new Map<string, TranscriptTaskRecord[]>();
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(opts?: TranscriptWriteQueueOptions) {
    this.drainIntervalMs = opts?.drainIntervalMs ?? DEFAULT_DRAIN_MS;
    this.sync = opts?.sync ?? false;
  }

  get depth(): number {
    return this.pending.length;
  }

  getPendingBytes(sessionId: string): number {
    return this.pendingBytesBySession.get(sessionId) ?? 0;
  }

  getPendingRecords(sessionId: string): TranscriptTaskRecord[] {
    return [...(this.pendingRecordsBySession.get(sessionId) ?? [])];
  }

  enqueue(sessionId: string, record: TranscriptTaskRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');

    if (this.sync) {
      ensureSessionsDir();
      appendFileSync(transcriptPath(sessionId), line, 'utf8');
      return;
    }

    this.pending.push({ sessionId, record, line, bytes });
    this.pendingBytesBySession.set(
      sessionId,
      (this.pendingBytesBySession.get(sessionId) ?? 0) + bytes,
    );
    const records = this.pendingRecordsBySession.get(sessionId) ?? [];
    records.push(record);
    this.pendingRecordsBySession.set(sessionId, records);
    this.ensureDrainWorker();
  }

  private ensureDrainWorker(): void {
    if (this.sync || this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      if (this.pending.length === 0 || this.flushing) return;
      void this.flushOneBatch();
    }, this.drainIntervalMs);
  }

  private stopDrainWorker(): void {
    if (!this.drainTimer) return;
    clearInterval(this.drainTimer);
    this.drainTimer = null;
  }

  private takeBatch(): QueuedTranscriptLine[] {
    return this.pending.splice(0, this.pending.length);
  }

  private releasePendingTracking(batch: QueuedTranscriptLine[]): void {
    for (const item of batch) {
      const bytesLeft = (this.pendingBytesBySession.get(item.sessionId) ?? 0) - item.bytes;
      if (bytesLeft <= 0) {
        this.pendingBytesBySession.delete(item.sessionId);
      } else {
        this.pendingBytesBySession.set(item.sessionId, bytesLeft);
      }

      const records = this.pendingRecordsBySession.get(item.sessionId);
      if (!records) continue;
      const idx = records.findIndex((r) => r.task_id === item.record.task_id);
      if (idx >= 0) records.splice(idx, 1);
      if (records.length === 0) {
        this.pendingRecordsBySession.delete(item.sessionId);
      }
    }
  }

  private async flushOneBatch(): Promise<TranscriptFlushInfo | null> {
    if (this.sync || this.pending.length === 0) {
      return null;
    }

    if (this.flushing) {
      await this.flushing;
      return { flush_ms: 0, count: 0, pending: this.pending.length };
    }

    const batch = this.takeBatch();
    if (batch.length === 0) return null;

    let info: TranscriptFlushInfo = { flush_ms: 0, count: 0, pending: 0 };

    this.flushing = (async () => {
      ensureSessionsDir();
      const t0 = performance.now();
      const bySession = new Map<string, string>();
      for (const item of batch) {
        bySession.set(item.sessionId, (bySession.get(item.sessionId) ?? '') + item.line);
      }
      await Promise.all(
        [...bySession.entries()].map(([sessionId, text]) =>
          appendFile(transcriptPath(sessionId), text, 'utf8'),
        ),
      );
      const flushMs = performance.now() - t0;
      this.releasePendingTracking(batch);
      info = {
        flush_ms: Math.round(flushMs * 100) / 100,
        count: batch.length,
        pending: this.pending.length,
      };
    })();

    try {
      await this.flushing;
    } finally {
      this.flushing = null;
      if (this.pending.length > 0) {
        void this.flushOneBatch();
      }
    }

    return info;
  }

  async flush(): Promise<TranscriptFlushInfo> {
    if (this.sync) {
      return { flush_ms: 0, count: 0, pending: 0 };
    }

    let totalCount = 0;
    let totalMs = 0;

    while (this.pending.length > 0) {
      const info = await this.flushOneBatch();
      if (!info || info.count === 0) break;
      totalCount += info.count;
      totalMs += info.flush_ms;
    }

    return {
      flush_ms: Math.round(totalMs * 100) / 100,
      count: totalCount,
      pending: this.pending.length,
    };
  }

  flushSync(): TranscriptFlushInfo {
    this.stopDrainWorker();
    if (this.pending.length === 0) {
      return { flush_ms: 0, count: 0, pending: 0 };
    }

    ensureSessionsDir();
    const t0 = performance.now();
    const batch = this.takeBatch();
    const bySession = new Map<string, string>();
    for (const item of batch) {
      bySession.set(item.sessionId, (bySession.get(item.sessionId) ?? '') + item.line);
    }
    for (const [sessionId, text] of bySession) {
      appendFileSync(transcriptPath(sessionId), text, 'utf8');
    }
    this.releasePendingTracking(batch);
    const flushMs = performance.now() - t0;
    return {
      flush_ms: Math.round(flushMs * 100) / 100,
      count: batch.length,
      pending: 0,
    };
  }

  dispose(): void {
    this.stopDrainWorker();
  }
}

let globalQueue: TranscriptWriteQueue | null = null;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function configureTranscriptWriteQueue(opts?: TranscriptWriteQueueOptions): void {
  if (globalQueue) {
    globalQueue.dispose();
  }

  const sync =
    opts?.sync ??
    (process.env.TRANSCRIPT_WRITE_SYNC === '1' || process.env.NODE_ENV === 'test');
  globalQueue = new TranscriptWriteQueue({
    drainIntervalMs: opts?.drainIntervalMs ?? envInt('TRANSCRIPT_WRITE_DRAIN_MS', DEFAULT_DRAIN_MS),
    sync,
  });
}

export function getTranscriptWriteQueue(): TranscriptWriteQueue {
  if (!globalQueue) {
    configureTranscriptWriteQueue();
  }
  return globalQueue!;
}

export function getTranscriptPendingBytes(sessionId: string): number {
  return getTranscriptWriteQueue().getPendingBytes(sessionId);
}

export function getTranscriptPendingRecords(sessionId: string): TranscriptTaskRecord[] {
  return getTranscriptWriteQueue().getPendingRecords(sessionId);
}

export async function flushTranscriptWrites(): Promise<TranscriptFlushInfo> {
  return getTranscriptWriteQueue().flush();
}

export function flushTranscriptWritesSync(): TranscriptFlushInfo {
  return getTranscriptWriteQueue().flushSync();
}

export function resetTranscriptWriteQueueForTests(): void {
  if (globalQueue) {
    globalQueue.flushSync();
    globalQueue.dispose();
  }
  globalQueue = null;
}