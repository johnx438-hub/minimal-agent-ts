import type { SpawnShellPolicy } from '../plugins/types.js';

export interface ResolvedSpawnPreset {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  maxTurns: number;
  /** C5: merged global+preset shell policy for the child agent. */
  shellPolicy?: SpawnShellPolicy;
}