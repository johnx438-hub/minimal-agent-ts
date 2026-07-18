import type { SpawnShellPolicy } from '../plugins/types.js';

export interface ResolvedSpawnPreset {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  maxTurns: number;
  /** SPEC_POINTERIZE_SCOPE: child keep window override. */
  keepInlineTurns?: number;
  /** P2: hold | window */
  pointerizeMode?: import('../plugins/types.js').PointerizeMode;
  /** C5: merged global+preset shell policy for the child agent. */
  shellPolicy?: SpawnShellPolicy;
}