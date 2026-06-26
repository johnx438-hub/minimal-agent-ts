import { chat } from './llm.js';
import { executeTool, TOOL_DEFINITIONS } from './tools.js';
import { TaskTracker } from './task-tracker.js';
import type { AgentConfig, ChatMessage, TaskSummaryDoc } from './types.js';

export interface RunAgentOptions {
  prompt: string;
  config: AgentConfig;
  initialMessages?: ChatMessage[];  // Pre-loaded messages from session
  sessionId?: string;               // Session ID for task tracking
  onStep?: (event: AgentStepEvent) => void;
  onTaskComplete?: (summary: TaskSummaryDoc) => void;  // Callback when task finishes
}

export type AgentStepEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'llm_done'; turn: number; finishReason: string | null; usage?: object }
  | { type: 'tool_call'; turn: number; name: string; args: string }
  | { type: 'tool_result'; turn: number; name: string; output: string }
  | { type: 'final'; turn: number; text: string };

export interface AgentResult {
  text: string;           // Final answer text
  messages: ChatMessage[]; // All messages (for session persistence)
}

/**
 * Minimal ReAct loop with task tracking and session support:
 *   Reason+Act (LLM) → Observe (tool results) → repeat until text answer or maxTurns.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const { prompt, config, initialMessages, sessionId, onStep, onTaskComplete } = opts;

  // Use provided messages or build from scratch
  const messages: ChatMessage[] = initialMessages ?? [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Working directory: ${config.cwd}\n\nTask:\n${prompt}`,
    },
  ];

  // Initialize task tracker if session ID is provided
  const tracker = sessionId ? new TaskTracker(sessionId) : null;

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    onStep?.({ type: 'turn_start', turn });

    const { message, finishReason, usage } = await chat(messages, TOOL_DEFINITIONS, {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    });

    onStep?.({ type: 'llm_done', turn, finishReason, usage });

    // Path A: model wants to call tools (Act)
    if (message.tool_calls && message.tool_calls.length > 0) {
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: message.content,
        tool_calls: message.tool_calls,
      };

      // Track task progress
      if (tracker) {
        tracker.onAssistantMessage(assistantMsg, turn);
      }

      messages.push(assistantMsg);

      for (const call of message.tool_calls) {
        const name = call.function.name;
        const args = call.function.arguments;

        onStep?.({ type: 'tool_call', turn, name, args });

        const output = await executeTool(name, args, config);

        onStep?.({ type: 'tool_result', turn, name, output });

        // Observe: feed tool result back into history
        const toolMsg: ChatMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: output,
        };

        if (tracker) {
          tracker.onToolResult(toolMsg);
        }

        messages.push(toolMsg);
      }

      continue; // next turn — LLM sees tool results (ReAct loop)
    }

    // Path B: model returned final text (Done)
    const text = (message.content ?? '').trim();
    if (text) {
      onStep?.({ type: 'final', turn, text });

      // Finalize task and generate summary
      if (tracker) {
        tracker.onAssistantMessage({ role: 'assistant', content: text }, turn);
        const taskBlock = tracker.finalizeCurrentTask();

        if (taskBlock) {
          const autoFields = tracker.extractAutoFields(taskBlock);

          // TODO: Add Agent-supplemented fields (pending_tasks, current_work)
          // For now, use the final answer as current_work
          const summary: TaskSummaryDoc = {
            ...autoFields,
            pending_tasks: [],  // Phase 1+: extract from final answer
            current_work: text.slice(0, 500),  // Truncate for safety
          };

          onTaskComplete?.(summary);
        }
      }

      return { text, messages };
    }

    // Path C: empty response — nudge and retry (zerostack-style continue)
    messages.push({ role: 'assistant', content: '' });
    messages.push({ role: 'user', content: 'Please continue or summarize what you found.' });
  }

  throw new Error(`max turns exceeded (${config.maxTurns})`);
}

const SYSTEM_PROMPT = `You are a minimal coding assistant in a learning demo.

You have tools: read_file, write_file, run_shell.
- Prefer read_file before editing.
- Explain briefly what you are doing.
- When the task is done, reply with a short summary and stop calling tools.`;