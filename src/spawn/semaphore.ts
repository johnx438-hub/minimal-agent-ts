/** Limits concurrent spawn_agent executions (global per process). */
export class SpawnSemaphore {
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.running < this.max) {
      this.running++;
      return () => this.release();
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.running++;
    return () => this.release();
  }

  private release(): void {
    this.running = Math.max(0, this.running - 1);
    const next = this.waiters.shift();
    if (next) next();
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