import { writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

import { actionFilePathForBlock } from './action-paths.js';
import type { ActionBlock } from './types.js';
import { isSpawnActive } from './spawn/semaphore.js';

const DEFAULT_DRAIN_MS = 100;
const DEFAULT_MAX_BATCH = 8;

export interface ActionFlushInfo {
  flush_ms: number;
  count: number;
  pending: number;
}

export type ActionFlushListener = (info: ActionFlushInfo) => void;

export interface ActionWriteQueueOptions {
  /** Background worker tick interval (async mode). */
  drainIntervalMs?: number;
  maxBatch?: number;
  /** When true, each enqueue writes synchronously (tests). */
  sync?: boolean;
  /** Pause background drain while spawn is active. */
  pauseDuringSpawn?: boolean;
  onFlush?: ActionFlushListener;
}

function writeActionFileSync(block: ActionBlock): void {
  writeFileSync(actionFilePathForBlock(block), JSON.stringify(block, null, 2), 'utf8');
}

async function writeActionFilesAsync(blocks: ActionBlock[]): Promise<void> {
  if (blocks.length === 0) return;
  await Promise.all(
    blocks.map((block) =>
      writeFile(actionFilePathForBlock(block), JSON.stringify(block, null, 2), 'utf8'),
    ),
  );
}

export class ActionWriteQueue {
  private readonly drainIntervalMs: number;
  private readonly maxBatch: number;
  private readonly sync: boolean;
  private readonly pauseDuringSpawn: boolean;
  private readonly onFlush?: ActionFlushListener;
  private readonly foreground = new Map<string, ActionBlock>();
  private readonly background = new Map<string, ActionBlock>();
  private activeSessionId: string | undefined;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private forceFlush = false;

  constructor(opts?: ActionWriteQueueOptions) {
    this.drainIntervalMs = opts?.drainIntervalMs ?? DEFAULT_DRAIN_MS;
    this.maxBatch = opts?.maxBatch ?? DEFAULT_MAX_BATCH;
    this.sync = opts?.sync ?? false;
    this.pauseDuringSpawn = opts?.pauseDuringSpawn ?? true;
    this.onFlush = opts?.onFlush;
  }

  get depth(): number {
    return this.foreground.size + this.background.size;
  }

  setActiveSessionId(sessionId: string | undefined): void {
    this.activeSessionId = sessionId;
  }

  enqueue(block: ActionBlock): number {
    const t0 = performance.now();
    if (this.sync) {
      writeActionFileSync(block);
      return performance.now() - t0;
    }

    const lane =
      this.activeSessionId && block.session_id !== this.activeSessionId
        ? this.background
        : this.foreground;
    lane.set(block.action_id, block);
    this.ensureDrainWorker();
    return performance.now() - t0;
  }

  private shouldPauseDrain(): boolean {
    return !this.forceFlush && this.pauseDuringSpawn && isSpawnActive();
  }

  private ensureDrainWorker(): void {
    if (this.sync || this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      if (this.shouldPauseDrain() || this.depth === 0 || this.flushing) return;
      void this.flushOneBatch();
    }, this.drainIntervalMs);
  }

  private stopDrainWorker(): void {
    if (!this.drainTimer) return;
    clearInterval(this.drainTimer);
    this.drainTimer = null;
  }

  private takeBatch(): ActionBlock[] {
    const batch: ActionBlock[] = [];
    for (const block of this.foreground.values()) {
      batch.push(block);
      this.foreground.delete(block.action_id);
      if (batch.length >= this.maxBatch) break;
    }
    if (batch.length < this.maxBatch) {
      for (const block of this.background.values()) {
        batch.push(block);
        this.background.delete(block.action_id);
        if (batch.length >= this.maxBatch) break;
      }
    }
    return batch;
  }

  private async flushOneBatch(): Promise<ActionFlushInfo | null> {
    if (this.sync) {
      return { flush_ms: 0, count: 0, pending: 0 };
    }

    if (this.flushing) {
      await this.flushing;
      return { flush_ms: 0, count: 0, pending: this.depth };
    }

    const batch = this.takeBatch();
    if (batch.length === 0) {
      return null;
    }

    let info: ActionFlushInfo = { flush_ms: 0, count: 0, pending: this.depth };

    this.flushing = (async () => {
      const t0 = performance.now();
      await writeActionFilesAsync(batch);
      const flushMs = performance.now() - t0;
      info = {
        flush_ms: Math.round(flushMs * 100) / 100,
        count: batch.length,
        pending: this.depth,
      };
      this.onFlush?.(info);
    })();

    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }

    return info;
  }

  async flush(): Promise<ActionFlushInfo> {
    if (this.sync) {
      return { flush_ms: 0, count: 0, pending: 0 };
    }

    this.forceFlush = true;
    let totalCount = 0;
    let totalMs = 0;

    try {
      while (this.depth > 0) {
        const info = await this.flushOneBatch();
        if (!info || info.count === 0) break;
        totalCount += info.count;
        totalMs += info.flush_ms;
      }
    } finally {
      this.forceFlush = false;
    }

    return {
      flush_ms: Math.round(totalMs * 100) / 100,
      count: totalCount,
      pending: this.depth,
    };
  }

  flushSync(): ActionFlushInfo {
    this.stopDrainWorker();

    const blocks = [...this.foreground.values(), ...this.background.values()];
    this.foreground.clear();
    this.background.clear();

    if (blocks.length === 0) {
      return { flush_ms: 0, count: 0, pending: 0 };
    }

    const t0 = performance.now();
    for (const block of blocks) {
      writeActionFileSync(block);
    }
    const flushMs = performance.now() - t0;
    const info: ActionFlushInfo = {
      flush_ms: Math.round(flushMs * 100) / 100,
      count: blocks.length,
      pending: 0,
    };
    this.onFlush?.(info);
    return info;
  }

  dispose(): void {
    this.stopDrainWorker();
  }
}

let globalQueue: ActionWriteQueue | null = null;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function configureActionWriteQueue(opts?: ActionWriteQueueOptions): void {
  if (globalQueue) {
    globalQueue.dispose();
  }

  const sync =
    opts?.sync ??
    (process.env.ACTION_WRITE_SYNC === '1' || process.env.NODE_ENV === 'test');
  const drainFallback = envInt('ACTION_WRITE_BATCH_MS', DEFAULT_DRAIN_MS);
  globalQueue = new ActionWriteQueue({
    drainIntervalMs: opts?.drainIntervalMs ?? envInt('ACTION_WRITE_DRAIN_MS', drainFallback),
    maxBatch: opts?.maxBatch ?? envInt('ACTION_WRITE_MAX_BATCH', DEFAULT_MAX_BATCH),
    sync,
    pauseDuringSpawn: opts?.pauseDuringSpawn ?? true,
    onFlush: opts?.onFlush,
  });
}

export function getActionWriteQueue(): ActionWriteQueue {
  if (!globalQueue) {
    configureActionWriteQueue();
  }
  return globalQueue!;
}

export function setActiveActionSessionId(sessionId: string | undefined): void {
  getActionWriteQueue().setActiveSessionId(sessionId);
}

export function getActionWriteQueueDepth(): number {
  return getActionWriteQueue().depth;
}

export async function flushActionWrites(): Promise<ActionFlushInfo> {
  return getActionWriteQueue().flush();
}

export function flushActionWritesSync(): ActionFlushInfo {
  return getActionWriteQueue().flushSync();
}

export function resetActionWriteQueueForTests(): void {
  if (globalQueue) {
    globalQueue.flushSync();
    globalQueue.dispose();
  }
  globalQueue = null;
}