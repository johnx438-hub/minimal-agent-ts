import { formatRecallResult, recallQuery } from '../recall.js';
import type { AgentConfig, ToolDefinition } from '../types.js';

export const RECALL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'recall_query',
      description:
        'Retrieve a prior tool result from cold storage. With action_id, returns full text up to ~24KB by default; larger bodies use offset/limit. Keyword search uses head_tail unless format=full.',
      parameters: {
        type: 'object',
        properties: {
          action_id: {
            type: 'string',
            description: 'Exact action_id from a pointer card (preferred)',
          },
          query: {
            type: 'string',
            description: 'Keyword search when action_id unknown',
          },
          task_id: { type: 'string', description: 'Limit search to a task_id' },
          scope: {
            type: 'string',
            enum: ['action', 'task', 'session'],
            description: 'Search scope when using query (default session)',
          },
          offset: { type: 'integer', description: '1-based start line for slicing' },
          limit: { type: 'integer', description: 'Max lines to return' },
          format: {
            type: 'string',
            enum: ['full', 'head_tail', 'grep'],
            description: 'Default head_tail (safe size)',
          },
        },
      },
    },
  },
];

export async function runRecallTool(
  name: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  if (name !== 'recall_query') return null;

  const result = await recallQuery(
    {
      action_id: args.action_id !== undefined ? String(args.action_id) : undefined,
      query: args.query !== undefined ? String(args.query) : undefined,
      task_id: args.task_id !== undefined ? String(args.task_id) : undefined,
      scope: args.scope as 'action' | 'task' | 'session' | undefined,
      offset: args.offset === undefined ? undefined : Number(args.offset),
      limit: args.limit === undefined ? undefined : Number(args.limit),
      format: args.format as 'full' | 'head_tail' | 'grep' | undefined,
    },
    config,
  );

  return formatRecallResult(result);
}