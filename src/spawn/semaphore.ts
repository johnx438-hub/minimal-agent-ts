type SemaphoreWaiter = {
  resolve: () => void;
  detachAbort?: () => void;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

/** Limits concurrent spawn_agent executions (global per process). */
export class SpawnSemaphore {
  private running = 0;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(private readonly max: number) {}

  get runningCount(): number {
    return this.running;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);

    if (this.running < this.max) {
      this.running++;
      return () => this.release();
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve };

      if (signal) {
        const onAbort = (): void => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }

      this.waiters.push(waiter);
    });

    this.running++;
    return () => this.release();
  }

  private release(): void {
    this.running = Math.max(0, this.running - 1);
    const next = this.waiters.shift();
    if (next) {
      next.detachAbort?.();
      next.resolve();
    }
  }
}

let globalSemaphore: SpawnSemaphore | null = null;

export function configureSpawnSemaphore(maxParallel: number): void {
  const n = Math.max(1, Math.floor(maxParallel));
  globalSemaphore = new SpawnSemaphore(n);
}

export function getSpawnSemaphore(): SpawnSemaphore {
  if (!globalSemaphore) {
    globalSemaphore = new SpawnSemaphore(1);
  }
  return globalSemaphore;
}

export function resetSpawnSemaphoreForTests(): void {
  globalSemaphore = null;
}

export function isSpawnActive(): boolean {
  return getSpawnSemaphore().runningCount > 0;
}