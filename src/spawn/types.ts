export interface ResolvedSpawnPreset {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  maxTurns: number;
}