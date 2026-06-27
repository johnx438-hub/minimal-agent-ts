import { saveAction } from './action-store.js';
import { assembleApiMessages } from './context-policy.js';
import { chat } from './llm.js';
import { materializePriorTurnTools } from './pointerize.js';
import { parseAgentSummary, extractCleanAnswer, getSummaryPromptExtension } from './summary.js';
import { buildContext, createBudgetConfig, shouldCompress, estimateTokens } from './context-budget.js';
import { executeTool, TOOL_DEFINITIONS } from './tools.js';
import { TaskTracker } from './task-tracker.js';
import type { AgentConfig, ChatMessage, TaskSummaryDoc, SessionFile } from './types.js';

export interface RunAgentOptions {
  prompt: string;
  config: AgentConfig;
  session?: SessionFile;
  sessionId?: string;
  onStep?: (event: AgentStepEvent) => void;
  onTaskComplete?: (summary: TaskSummaryDoc) => void;
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
function stripSystemMessages(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.filter((m) => m.role !== 'system');
}

function buildUserTaskMessage(cwd: string, prompt: string): ChatMessage {
  return {
    role: 'user',
    content: `Working directory: ${cwd}\n\nTask:\n${prompt}`,
  };
}

/** Assemble the first message batch: system + history (+ compression) + new user task. */
function resolveInitialMessages(opts: RunAgentOptions): {
  messages: ChatMessage[];
  userTask: ChatMessage;
} {
  const { prompt, config, session } = opts;
  const system: ChatMessage = { role: 'system', content: SYSTEM_PROMPT };
  const userTask = buildUserTaskMessage(config.cwd, prompt);

  if (!session) {
    return { messages: [system, userTask], userTask };
  }

  const history = stripSystemMessages(session.current_messages);
  const budget = createBudgetConfig(config.model);

  if (
    session.tasks.length > 0 &&
    shouldCompress(estimateTokens(session.current_messages), budget)
  ) {
    const compressed = stripSystemMessages(buildContext(session, budget));
    return { messages: [system, ...compressed, userTask], userTask };
  }

  if (history.length > 0) {
    return { messages: [system, ...history, userTask], userTask };
  }

  return { messages: [system, userTask], userTask };
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const { config, session, sessionId, onStep, onTaskComplete } = opts;

  const { messages: initial, userTask } = resolveInitialMessages(opts);
  const messages = [...initial];

  const tracker = sessionId
    ? new TaskTracker(sessionId, session?.tasks.length ?? 0)
    : null;
  if (tracker) {
    tracker.onUserMessage(userTask, 1);
  }

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    onStep?.({ type: 'turn_start', turn });

    if (turn > 1) {
      materializePriorTurnTools(messages, turn);
    }

    const apiMessages = assembleApiMessages(messages);

    const { message, finishReason, usage } = await chat(apiMessages, TOOL_DEFINITIONS, {
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

        let actionId: string | undefined;
        if (tracker) {
          const block = tracker.recordToolCall(name, args, output, turn);
          if (block) {
            saveAction(block);
            actionId = block.action_id;
          }
        }

        const toolMsg: ChatMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: output,
          action_id: actionId,
          turn,
        };

        if (tracker) {
          tracker.onToolResult(toolMsg);
        }

        messages.push(toolMsg);
      }

      continue; // next turn — LLM sees tool results (ReAct loop)
    }

    // Path B: model returned final text (Done)
    const rawText = (message.content ?? '').trim();
    if (rawText) {
      // Parse Agent-supplemented fields from appended JSON
      const agentFields = parseAgentSummary(rawText);
      const cleanText = extractCleanAnswer(rawText);

      onStep?.({ type: 'final', turn, text: cleanText });

      // Finalize task and generate summary
      if (tracker) {
        tracker.onAssistantMessage({ role: 'assistant', content: rawText }, turn);
        const taskBlock = tracker.finalizeCurrentTask();

        if (taskBlock) {
          const autoFields = tracker.extractAutoFields(taskBlock);

          // Hybrid summary: auto-extracted + Agent-supplemented (~50 tokens)
          const summary: TaskSummaryDoc = {
            ...autoFields,
            pending_tasks: agentFields.pending_tasks,
            current_work: agentFields.current_work || cleanText.slice(0, 500),
          };

          onTaskComplete?.(summary);
        }
      }

      return { text: cleanText, messages };
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
- When the task is done, reply with a short summary and stop calling tools.
- Large tool outputs may appear as [action:…] cards; full text is stored and can be retrieved via recall_query (Phase 2b).${getSummaryPromptExtension()}`;