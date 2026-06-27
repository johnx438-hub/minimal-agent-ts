import type { AgentConfig, ToolDefinition } from '../types.js';
import { EXPLORE_DEFINITIONS, runExploreTool } from './explore.js';
import { READ_WRITE_DEFINITIONS, runReadWriteTool } from './read-write.js';
import { RECALL_DEFINITIONS, runRecallTool } from './recall.js';
import { SHELL_DEFINITIONS, runShellTool } from './shell.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...READ_WRITE_DEFINITIONS,
  ...EXPLORE_DEFINITIONS,
  ...RECALL_DEFINITIONS,
  ...SHELL_DEFINITIONS,
];

export async function executeTool(
  name: string,
  argsJson: string,
  config: AgentConfig,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return `error: invalid JSON arguments: ${argsJson}`;
  }

  try {
    const handlers = [runReadWriteTool, runExploreTool, runRecallTool, runShellTool];
    for (const handler of handlers) {
      const result = await handler(name, args, config);
      if (result !== null) return result;
    }
    return `error: unknown tool ${name}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `error: ${msg}`;
  }
}