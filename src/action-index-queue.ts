import type { ActionBlock } from './types.js';
import { isSpawnActive } from './spawn/semaphore.js';

const DEFAULT_PAUSE_POLL_MS = 50;

export interface IndexFlushInfo {
  flush_ms: number;
  count: number;
  pending: number;
}

export type IndexFlushListener = (info: IndexFlushInfo) => void;

type UpsertFn = (block: ActionBlock) => Promise<void>;

export interface ActionIndexQueueOptions {
  pausePollMs?: number;
  upsert?: UpsertFn;
  onFlush?: IndexFlushListener;
}

async function defaultUpsert(block: ActionBlock): Promise<void> {
  const { upsertActionIndex } = await import('./action-index.js');
  await upsertActionIndex(block);
}

export class ActionIndexQueue {
  private readonly pausePollMs: number;
  private readonly upsert: UpsertFn;
  private readonly onFlush?: IndexFlushListener;
  private readonly pending: ActionBlock[] = [];
  private worker: Promise<void> | null = null;
  private forceFlush = false;
  private flushAccumMs = 0;
  private flushAccumCount = 0;

  constructor(opts?: ActionIndexQueueOptions) {
    this.pausePollMs = opts?.pausePollMs ?? DEFAULT_PAUSE_POLL_MS;
    this.upsert = opts?.upsert ?? defaultUpsert;
    this.onFlush = opts?.onFlush;
  }

  get depth(): number {
    return this.pending.length;
  }

  enqueue(block: ActionBlock): void {
    this.pending.push(block);
    this.ensureWorker();
  }

  private shouldPause(): boolean {
    return !this.forceFlush && isSpawnActive();
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.shouldPause()) {
      await new Promise((resolve) => setTimeout(resolve, this.pausePollMs));
    }
  }

  private ensureWorker(): void {
    if (this.worker) return;
    this.worker = this.runWorker().finally(() => {
      this.worker = null;
      if (this.pending.length > 0) {
        this.ensureWorker();
      }
    });
  }

  private async runWorker(): Promise<void> {
    while (this.pending.length > 0) {
      if (this.shouldPause()) {
        await this.waitWhilePaused();
        continue;
      }

      const block = this.pending.shift();
      if (!block) break;

      const t0 = performance.now();
      try {
        await this.upsert(block);
      } catch {
        /* indexing is best-effort */
      }
      const flushMs = performance.now() - t0;
      const roundedMs = Math.round(flushMs * 100) / 100;
      if (this.forceFlush) {
        this.flushAccumMs += roundedMs;
        this.flushAccumCount += 1;
      }
      this.onFlush?.({
        flush_ms: roundedMs,
        count: 1,
        pending: this.pending.length,
      });
    }
  }

  async flush(): Promise<IndexFlushInfo> {
    this.flushAccumMs = 0;
    this.flushAccumCount = 0;
    this.forceFlush = true;
    try {
      while (this.pending.length > 0 || this.worker) {
        this.ensureWorker();
        if (this.worker) {
          await this.worker;
        }
      }
    } finally {
      this.forceFlush = false;
    }
    return {
      flush_ms: Math.round(this.flushAccumMs * 100) / 100,
      count: this.flushAccumCount,
      pending: 0,
    };
  }
}

let globalQueue: ActionIndexQueue | null = null;

export function configureActionIndexQueue(opts?: ActionIndexQueueOptions): void {
  globalQueue = new ActionIndexQueue(opts);
}

export function getActionIndexQueue(): ActionIndexQueue {
  if (!globalQueue) {
    configureActionIndexQueue();
  }
  return globalQueue!;
}

export function getActionIndexQueueDepth(): number {
  return getActionIndexQueue().depth;
}

export function enqueueActionIndex(block: ActionBlock): void {
  getActionIndexQueue().enqueue(block);
}

export async function flushActionIndex(): Promise<IndexFlushInfo> {
  return getActionIndexQueue().flush();
}

export function resetActionIndexQueueForTests(): void {
  globalQueue = null;
}