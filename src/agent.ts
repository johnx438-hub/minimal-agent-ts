import { indexActionAsync, scheduleIndexSync } from './action-index.js';

import { beginTurnIo, buildTurnIoEvent } from './action-io-metrics.js';
import { saveAction } from './action-store.js';
import { flushActionWritesSync } from './action-write-queue.js';
import {
  assembleApiMessages,
  maybeCompactPointerCards,
  maybePrune,
  runCompressionEvent,
} from './context-policy.js';
import {
  commitAssistantText,
  commitAssistantToolCalls,
  invokeLlmTurn,
} from './stream-draft.js';
import {
  EMPTY_CONTINUE_NUDGE,
  FORCED_SUMMARY_RETRY_NUDGE,
  isRegressionTaskPrompt,
  LoopGuard,
  resolveTurnCeiling,
  stripLoopGuardInjections,
  type LoopGuardConfig,
  type ToolTurnRecord,
} from './loop-guard.js';
import {
  attachActionPreview,
  DEFAULT_PREVIEW_POLICY,
  formatLiveToolPreview,
} from './action-preview.js';
import { buildSystemPrompt } from './agent-prompt.js';
import { isAbortError, type AgentStepEvent } from './events.js';
import { materializePriorTurnTools } from './pointerize.js';
import { parseAgentSummary, extractCleanAnswer } from './summary.js';
import { buildContext, createBudgetConfig, shouldCompress, estimateTokens } from './context-budget.js';
import { scheduleToolCalls } from './tool-scheduler.js';
import { executeTool, getToolDefinitions } from './tools.js';
import { splitEditToolOutput } from './tools/edit-display.js';
import { splitWriteToolOutput } from './tools/write-display.js';
import { TaskTracker, type TaskBlock } from './task-tracker.js';
import type { AgentConfig, ChatMessage, TaskSummaryDoc, SessionFile, ToolCall } from './types.js';

export interface RunAgentOptions {
  prompt: string;
  config: AgentConfig;
  session?: SessionFile;
  sessionId?: string;
  stream?: boolean;
  /** Replaces default coding-assistant system prompt (workflow roles). */
  systemPrompt?: string;
  /** Skip session history; only system + this user task (workflow steps). */
  isolated?: boolean;
  onStep?: (event: AgentStepEvent) => void;
  onTaskComplete?: (summary: TaskSummaryDoc, taskBlock: TaskBlock) => void;
  signal?: AbortSignal;
}

export interface AgentResult {
  text: string;
  messages: ChatMessage[];
}

const DEFAULT_LOOP_GUARD: LoopGuardConfig = {
  enabled: true,
  mode: 'inject',
  hardCeiling: 200,
};

const ABORTED_TOOL_OUTPUT = '[aborted]';

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

/** Reject as soon as signal aborts — do not wait for in-flight parallel work. */
function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    }),
  ]);
}

function stripSystemMessages(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.filter((m) => m.role !== 'system');
}

function buildUserTaskMessage(cwd: string, prompt: string): ChatMessage {
  return {
    role: 'user',
    content: `Working directory: ${cwd}\n\nTask:\n${prompt}`,
  };
}

function resolveInitialMessages(opts: RunAgentOptions): {
  messages: ChatMessage[];
  userTask: ChatMessage;
} {
  const { prompt, config, session, systemPrompt, isolated } = opts;
  const system: ChatMessage = {
    role: 'system',
    content: systemPrompt ?? buildSystemPrompt(config),
  };
  const userTask = buildUserTaskMessage(config.cwd, prompt);

  if (!session || isolated) {
    return { messages: [system, userTask], userTask };
  }

  const history = stripLoopGuardInjections(stripSystemMessages(session.current_messages));
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

function buildStoppedResult(
  messages: ChatMessage[],
  reason: string,
  turn: number,
  onStep?: RunAgentOptions['onStep'],
): AgentResult {
  const text = `[Agent stopped: ${reason}]`;
  messages.push({ role: 'assistant', content: text });
  onStep?.({ type: 'loop_guard', turn, action: 'terminate', reason });
  onStep?.({ type: 'final', turn, text });
  return { text, messages };
}

function finalizeSuccess(
  messages: ChatMessage[],
  rawText: string,
  turn: number,
  tracker: TaskTracker | null,
  onStep?: RunAgentOptions['onStep'],
  onTaskComplete?: RunAgentOptions['onTaskComplete'],
): AgentResult {
  const agentFields = parseAgentSummary(rawText);
  const cleanText = extractCleanAnswer(rawText);

  onStep?.({ type: 'final', turn, text: cleanText });

  if (tracker) {
    tracker.onAssistantMessage({ role: 'assistant', content: rawText }, turn);
    const taskBlock = tracker.finalizeCurrentTask();

    if (taskBlock) {
      const autoFields = tracker.extractAutoFields(taskBlock);
      const summary: TaskSummaryDoc = {
        ...autoFields,
        pending_tasks: agentFields.pending_tasks,
        current_work: agentFields.current_work || cleanText.slice(0, 500),
      };
      onTaskComplete?.(summary, taskBlock);
    }
  }

  return { text: cleanText, messages: stripLoopGuardInjections(messages) };
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const { config, session, sessionId, stream = true, onStep, onTaskComplete, signal } = opts;

  const toolConfig: AgentConfig = {
    ...config,
    sessionId: sessionId ?? session?.session_id,
    abortSignal: signal ?? config.abortSignal,
    nestedStepSink: onStep,
    spawnDepth: config.spawnDepth ?? 0,
  };

  const previewPolicy = config.previewPolicy ?? DEFAULT_PREVIEW_POLICY;

  const loopGuardConfig: LoopGuardConfig = {
    ...DEFAULT_LOOP_GUARD,
    ...config.loopGuard,
    regressionMode:
      config.loopGuard?.regressionMode ?? isRegressionTaskPrompt(opts.prompt),
  };
  const loopGuard = new LoopGuard(loopGuardConfig);
  const turnCeiling = resolveTurnCeiling(config.maxTurns, loopGuardConfig.hardCeiling);

  const { messages: initial, userTask } = resolveInitialMessages(opts);
  const messages = [...initial];

  const tracker = sessionId
    ? new TaskTracker(sessionId, session?.tasks.length ?? 0, config.spawnParentSessionId)
    : null;
  if (tracker) {
    tracker.onUserMessage(userTask, 1);
  }

  scheduleIndexSync(toolConfig.sessionId);

  const budget = createBudgetConfig(config.model);
  try {
  for (let turn = 1; ; turn++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (turn > turnCeiling) {
      return buildStoppedResult(
        messages,
        `turn ceiling reached (${turnCeiling})`,
        turn,
        onStep,
      );
    }

    onStep?.({ type: 'turn_start', turn });
    beginTurnIo(turn);

    if (loopGuard.shouldForceSummaryTurn()) {
      loopGuard.activateForcedSummary();
      onStep?.({
        type: 'loop_guard',
        turn,
        action: 'forced_summary',
        reason: 'repeated tool calls with no progress',
      });

      const apiMessages = assembleApiMessages(messages);
      const { message, finishReason, usage } = await invokeLlmTurn({
        turn,
        apiMessages,
        tools: [],
        stream,
        onStep,
        chatOpts: {
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
          stream,
          signal: toolConfig.abortSignal,
        },
      });

      onStep?.({ type: 'llm_done', turn, finishReason, usage });

      if (message.tool_calls && message.tool_calls.length > 0) {
        const decision = loopGuard.onForcedSummaryViolation();
        return buildStoppedResult(messages, decision.reason ?? 'forced summary violated', turn, onStep);
      }

      const rawText = (message.content ?? '').trim();
      if (rawText) {
        commitAssistantText(messages, rawText, turn);
        loopGuard.afterTextResponse();
        return finalizeSuccess(messages, rawText, turn, tracker, onStep, onTaskComplete);
      }

      commitAssistantText(messages, '', turn);
      const emptyDecision = loopGuard.afterEmptyResponse();
      if (emptyDecision.action === 'terminate') {
        return buildStoppedResult(messages, emptyDecision.reason ?? 'empty during summary', turn, onStep);
      }
      messages.push({
        role: 'user',
        content: FORCED_SUMMARY_RETRY_NUDGE,
      });
      continue;
    }

    if (turn > 1) {
      materializePriorTurnTools(messages, turn, {
        keepInlineTurns: config.keepInlineTurns ?? 2,
        previewPolicy: config.previewPolicy ?? DEFAULT_PREVIEW_POLICY,
      });

      const pruned = maybePrune(messages, turn);
      if (pruned > 0) {
        onStep?.({ type: 'compression', turn, pruned });
      }

      const pointerCompacted = maybeCompactPointerCards(messages, turn, budget);
      if (pointerCompacted > 0) {
        onStep?.({ type: 'compression', turn, pointer_compacted: pointerCompacted });
      }

      if (
        runCompressionEvent({
          messages,
          session,
          currentTurn: turn,
          budget,
          userTask,
        })
      ) {
        onStep?.({ type: 'compression', turn });
      }
    }

    const apiMessages = assembleApiMessages(messages);
    const toolDefs = getToolDefinitions(toolConfig);

    const { message, finishReason, usage } = await invokeLlmTurn({
      turn,
      apiMessages,
      tools: toolDefs,
      stream,
      onStep,
      chatOpts: {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        stream,
        signal: toolConfig.abortSignal,
      },
    });

    onStep?.({ type: 'llm_done', turn, finishReason, usage });

    if (message.tool_calls && message.tool_calls.length > 0) {
      throwIfAborted(signal);

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: message.content,
        tool_calls: message.tool_calls,
        turn,
      };

      if (tracker) {
        tracker.onAssistantMessage(assistantMsg, turn);
      }

      commitAssistantToolCalls(messages, message, turn);

      const plan = scheduleToolCalls(message.tool_calls);
      const total = message.tool_calls.length;
      if (total >= 2) {
        onStep?.({
          type: 'tool_plan',
          turn,
          total,
          parallel_count: plan.parallel.length,
          serial_count: plan.serial.length,
          entries: plan.entries,
        });
      }
      onStep?.({
        type: 'tool_batch',
        turn,
        total,
        parallel: plan.parallel.length,
      });

      const resultById = new Map<string, { output: string; actionId?: string }>();
      const turnRecords: ToolTurnRecord[] = [];

      async function runOne(call: ToolCall): Promise<void> {
        if (signal?.aborted) {
          resultById.set(call.id, { output: ABORTED_TOOL_OUTPUT });
          return;
        }

        const name = call.function.name;
        const args = call.function.arguments;

        onStep?.({ type: 'tool_call', turn, call_id: call.id, name, args });

        const rawOutput = await executeTool(name, args, toolConfig);
        let output = rawOutput;
        let display: string | undefined;
        if (name === 'write_file') {
          ({ output, display } = splitWriteToolOutput(rawOutput));
        } else if (name === 'edit_file') {
          ({ output, display } = splitEditToolOutput(rawOutput));
        }

        const preview = formatLiveToolPreview(name, args, output, previewPolicy);
        onStep?.({
          type: 'tool_result',
          turn,
          call_id: call.id,
          name,
          args,
          output,
          preview,
          display,
        });
        turnRecords.push({ name, argsJson: args, output });

        let actionId: string | undefined;
        if (tracker) {
          const block = tracker.recordToolCall(name, args, output, turn);
          if (block) {
            attachActionPreview(block, config.previewPolicy ?? DEFAULT_PREVIEW_POLICY);
            saveAction(block);
            indexActionAsync(block);
            actionId = block.action_id;
          }
        }

        resultById.set(call.id, { output, actionId });
      }

      try {
        await awaitWithAbort(Promise.all(plan.parallel.map(runOne)), signal);
        for (const call of plan.serial) {
          if (signal?.aborted) {
            resultById.set(call.id, { output: ABORTED_TOOL_OUTPUT });
            continue;
          }
          await awaitWithAbort(runOne(call), signal);
        }
      } catch (err) {
        if (!isAbortError(err)) throw err;
        for (const call of message.tool_calls) {
          if (!resultById.has(call.id)) {
            resultById.set(call.id, { output: ABORTED_TOOL_OUTPUT });
          }
        }
      }

      if (signal?.aborted) {
        for (const call of message.tool_calls) {
          if (!resultById.has(call.id)) {
            resultById.set(call.id, { output: ABORTED_TOOL_OUTPUT });
          }
          const result = resultById.get(call.id);
          if (!result) continue;

          const toolMsg: ChatMessage = {
            role: 'tool',
            tool_call_id: call.id,
            content: result.output,
            action_id: result.actionId,
            turn,
          };
          if (tracker) tracker.onToolResult(toolMsg);
          messages.push(toolMsg);
        }
        throw new DOMException('Aborted', 'AbortError');
      }

      for (const call of message.tool_calls) {
        const result = resultById.get(call.id);
        if (!result) continue;

        const toolMsg: ChatMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: result.output,
          action_id: result.actionId,
          turn,
        };

        if (tracker) {
          tracker.onToolResult(toolMsg);
        }

        messages.push(toolMsg);
      }

      const turnIo = buildTurnIoEvent(turn);
      if (turnIo) onStep?.(turnIo);

      const loopDecision = loopGuard.afterToolTurn(turn, turnRecords);
      if (loopDecision.action === 'soft_nudge' && loopDecision.message) {
        messages.push({ role: 'user', content: loopDecision.message });
        onStep?.({ type: 'loop_guard', turn, action: 'soft_nudge' });
      } else if (loopDecision.action === 'forced_summary' && loopDecision.message) {
        messages.push({ role: 'user', content: loopDecision.message });
        onStep?.({
          type: 'loop_guard',
          turn,
          action: 'forced_summary',
          reason: loopDecision.reason,
        });
      } else if (loopDecision.action === 'terminate') {
        return buildStoppedResult(messages, loopDecision.reason ?? 'loop detected', turn, onStep);
      }

      continue;
    }

    const rawText = (message.content ?? '').trim();
    if (rawText) {
      commitAssistantText(messages, rawText, turn);
      loopGuard.afterTextResponse();
      return finalizeSuccess(messages, rawText, turn, tracker, onStep, onTaskComplete);
    }

    commitAssistantText(messages, '', turn);
    const emptyDecision = loopGuard.afterEmptyResponse();
    if (emptyDecision.action === 'terminate') {
      return buildStoppedResult(messages, emptyDecision.reason ?? 'empty responses', turn, onStep);
    }

    messages.push({ role: 'user', content: EMPTY_CONTINUE_NUDGE });
  }
  } catch (err) {
    if (isAbortError(err)) {
      flushActionWritesSync();
      const text = '[aborted]';
      const lastTurn =
        [...messages].reverse().find((m) => m.turn !== undefined)?.turn ?? 1;
      onStep?.({ type: 'final', turn: lastTurn, text });
      return { text, messages };
    }
    throw err;
  }
}