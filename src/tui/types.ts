import type { AgentRuntime } from '../runner.js';

export interface TuiAppOptions {
  runtime: AgentRuntime;
  noShell?: boolean;
  noWeb?: boolean;
  allowWeb?: boolean;
}