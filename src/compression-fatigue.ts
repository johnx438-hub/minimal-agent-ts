export interface CompressionFatigueConfig {
  /** Turns to look back from the latest compression event. */
  windowTurns?: number;
  /** Compression events in window that trigger a soft prompt. */
  compressionThreshold?: number;
  /** Total pruned messages in window that trigger a soft prompt. */
  prunedThreshold?: number;
}

const DEFAULT_CONFIG: Required<CompressionFatigueConfig> = {
  windowTurns: 40,
  compressionThreshold: 2,
  prunedThreshold: 30,
};

interface CompressionRecord {
  turn: number;
  pruned: number;
}

/**
 * Tracks compression events across runs in a TUI session.
 * When thresholds are exceeded, suggests handoff / clear / continue.
 */
export class CompressionFatigueTracker {
  private readonly config: Required<CompressionFatigueConfig>;
  private records: CompressionRecord[] = [];
  private maxTurn = 0;
  private snoozed = false;

  constructor(config?: CompressionFatigueConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  onCompression(turn: number, pruned = 0): void {
    this.maxTurn = Math.max(this.maxTurn, turn);
    this.records.push({ turn, pruned });
    const cutoff = this.maxTurn - this.config.windowTurns;
    this.records = this.records.filter((r) => r.turn >= cutoff);
  }

  shouldPrompt(): boolean {
    if (this.snoozed) return false;
    if (this.records.length < this.config.compressionThreshold) return false;

    const compressions = this.records.length;
    const totalPruned = this.records.reduce((sum, r) => sum + r.pruned, 0);

    return (
      compressions >= this.config.compressionThreshold ||
      totalPruned >= this.config.prunedThreshold
    );
  }

  /** User chose an option — do not prompt again until next session or explicit reset. */
  snooze(): void {
    this.snoozed = true;
  }

  reset(): void {
    this.records = [];
    this.maxTurn = 0;
    this.snoozed = false;
  }

  stats(): { compressions: number; totalPruned: number; windowTurns: number } {
    return {
      compressions: this.records.length,
      totalPruned: this.records.reduce((sum, r) => sum + r.pruned, 0),
      windowTurns: this.config.windowTurns,
    };
  }
}