import * as readline from 'node:readline';

export type FatigueChoice = 'continue' | 'brief' | 'clear';

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function createFatiguePrompter(
  stats: { compressions: number; totalPruned: number },
): () => Promise<FatigueChoice> {
  return async () => {
    console.log(
      `\n⚠ Context compression fatigue (${stats.compressions} events, ${stats.totalPruned} messages pruned recently)`,
    );
    console.log('  [1] continue   [2] brief + new session   [3] clear context');
    const answer = await promptLine('› fatigue ');
    const a = answer.trim().toLowerCase();
    if (a === '2' || a === 'brief' || a === 'b') return 'brief';
    if (a === 'handoff' || a === 'h') {
      console.log('  (deprecated: handoff → use brief)');
      return 'brief';
    }
    if (a === '3' || a === 'clear' || a === 'c') return 'clear';
    return 'continue';
  };
}