import { chat } from './llm.js';
import { executeTool, TOOL_DEFINITIONS } from './tools.js';
import type { AgentConfig, ChatMessage } from './types.js';

const SYSTEM_PROMPT = `You are a minimal coding assistant in a learning demo.

You have tools: read_file, write_file, run_shell.
- Prefer read_file before editing.
- Explain briefly what you are doing.
- When the task is done, reply with a short summary and stop calling tools.`;

export interface RunAgentOptions {
  prompt: string;
  config: AgentConfig;
  onStep?: (event: AgentStepEvent) => void;
}

export type AgentStepEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'llm_done'; turn: number; finishReason: string | null; usage?: object }
  | { type: 'tool_call'; turn: number; name: string; args: string }
  | { type: 'tool_result'; turn: number; name: string; output: string }
  | { type: 'final'; turn: number; text: string };

/**
 * Minimal ReAct loop:
 *   Reason+Act (LLM) → Observe (tool results) → repeat until text answer or maxTurns.
 */
export async function runAgent(opts: RunAgentOptions): Promise<string> {
  const { prompt, config, onStep } = opts;

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Working directory: ${config.cwd}\n\nTask:\n${prompt}`,
    },
  ];

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
      messages.push({
        role: 'assistant',
        content: message.content,
        tool_calls: message.tool_calls,
      });

      for (const call of message.tool_calls) {
        const name = call.function.name;
        const args = call.function.arguments;

        onStep?.({ type: 'tool_call', turn, name, args });

        const output = await executeTool(name, args, config);

        onStep?.({ type: 'tool_result', turn, name, output });

        // Observe: feed tool result back into history
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: output,
        });
      }

      continue; // next turn — LLM sees tool results (ReAct loop)
    }

    // Path B: model returned final text (Done)
    const text = (message.content ?? '').trim();
    if (text) {
      onStep?.({ type: 'final', turn, text });
      return text;
    }

    // Path C: empty response — nudge and retry (zerostack-style continue)
    messages.push({ role: 'assistant', content: '' });
    messages.push({ role: 'user', content: 'Please continue or summarize what you found.' });
  }

  throw new Error(`max turns exceeded (${config.maxTurns})`);
}