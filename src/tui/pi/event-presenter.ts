import { CancellableLoader, Markdown, Text, type TUI } from '@earendil-works/pi-tui';

import {
  formatLlmRetrySummary,
  formatRunStartLlmSummary,
  formatToolPlanSummary,
  type AgentStepEvent,
  type RunStartLlmMeta,
  type RuntimeEvent,
} from '../../events.js';
import { shouldFormatFinal } from '../markdown.js';
import type { PiChatLog } from './chat-log.js';
import { piChalk, piMarkdownTheme } from './themes.js';
import {
  formatGenericToolFailureLine,
  formatToolBreadcrumb,
  isToolFailure,
  toolDisplayTier,
} from './tool-compact.js';
import { PiToolPresenter } from './tool-presenter.js';

function isAgentStep(event: RuntimeEvent): event is AgentStepEvent {
  return (
    event.type === 'turn_start' ||
    event.type === 'token' ||
    event.type === 'llm_done' ||
    event.type === 'llm_retry' ||
    event.type === 'tool_plan' ||
    event.type === 'tool_batch' ||
    event.type === 'tool_call' ||
    event.type === 'tool_result' ||
    event.type === 'compression' ||
    event.type === 'draft_discarded' ||
    event.type === 'loop_guard' ||
    event.type === 'final'
  );
}

export interface PiEventPresenterOptions {
  chat: PiChatLog;
  tui: TUI;
  onAbort?: () => void;
}

export class PiEventPresenter {
  private readonly chat: PiChatLog;
  private readonly tui: TUI;
  private readonly onAbort?: () => void;

  private streamBuffer = '';
  private streamMd: Markdown | null = null;
  private loader: CancellableLoader | null = null;
  private readonly toolPresenter: PiToolPresenter;

  constructor(opts: PiEventPresenterOptions) {
    this.chat = opts.chat;
    this.tui = opts.tui;
    this.onAbort = opts.onAbort;
    this.toolPresenter = new PiToolPresenter({
      chat: this.chat,
      tui: this.tui,
      getAnchor: () => this.streamMd ?? this.loader,
    });
  }

  handle(event: RuntimeEvent): void {
    if (isAgentStep(event)) {
      this.handleAgentStep(event);
      return;
    }

    switch (event.type) {
      case 'run_start':
        this.beginRun(event.session_id, event.cwd, event.agent_md, event.memory, event.llm);
        break;
      case 'run_stopping':
        this.setStopping();
        break;
      case 'run_end':
        this.endRun(event.reason, event.message);
        break;
      case 'session_saved':
        this.chat.appendText(`💾 session saved (${event.task_count} tasks)`, true);
        break;
      case 'runtime':
        this.chat.appendText(
          `⚙ shell:${event.shell ? 'on' : 'off'} web:${event.web ? 'on' : 'off'}`,
          true,
        );
        break;
      case 'permission_prompt_start':
        this.appendRunMeta(`permission ▶ ${event.kind} (${event.reason})`);
        break;
      case 'permission_prompt_end':
        this.appendRunMeta(
          `permission ${event.approved ? '✓' : '⊗'} ${event.kind} (${event.reason})`,
        );
        break;
      case 'workflow_confirm_start':
        this.appendRunMeta(
          `workflow confirm ▶ ${event.workflow}\n  shell:${event.needs_shell ? 'required' : 'no'} web:${event.needs_web ? 'required' : 'no'}`,
        );
        break;
      case 'workflow_confirm_end':
        this.appendRunMeta(
          `workflow confirm ${event.approved ? '✓' : '⊗'} ${event.workflow} (${event.reason})`,
        );
        break;
      case 'workflow_step': {
        const round = event.round !== undefined ? ` round ${event.round}` : '';
        this.chat.appendText(`workflow ▶ ${event.phase} / ${event.role}${round}`);
        break;
      }
      case 'workflow_handback': {
        const round =
          event.round !== undefined
            ? ` round ${event.round}`
            : '';
        const role = event.role ? `  role: ${event.role}${round}\n` : '';
        this.chat.appendText(
          `workflow handback ▶ ${event.workflow} (${event.reason})\n${role}  ${event.detail}`,
        );
        break;
      }
      case 'spawn_start':
        this.appendRunMeta(`spawn ▶ ${event.preset}`);
        break;
      case 'spawn_end':
        if (event.ok) {
          this.appendRunMeta(`spawn ✓ ${event.preset}`);
        } else {
          this.appendRunMeta(
            `spawn ✗ ${event.preset}${event.detail ? `: ${event.detail}` : ''}`,
          );
        }
        break;
    }
  }

  /** Tool / turn meta — always above the streaming LLM block. */
  private appendRunMeta(text: string, dim = true): void {
    const comp = new Text(text, 1, 0, dim ? (s) => piChalk.dim(s) : undefined);
    const anchor = this.streamMd ?? this.loader;
    if (anchor) {
      this.chat.insertBefore(comp, anchor);
    } else {
      this.chat.insertBeforeEditor(comp);
    }
  }

  /** Status after the reply block (e.g. [done], finish reason). */
  private appendRunFooter(text: string, dim = true): void {
    const comp = new Text(text, 1, 0, dim ? (s) => piChalk.dim(s) : undefined);
    if (this.loader) {
      this.chat.insertBefore(comp, this.loader);
    } else {
      this.chat.insertBeforeEditor(comp);
    }
  }

  private ensureStreamMd(): Markdown {
    if (this.streamMd) return this.streamMd;
    const comp = new Markdown('', 1, 1, piMarkdownTheme);
    const anchor = this.loader;
    if (anchor) {
      this.chat.insertBefore(comp, anchor);
    } else {
      this.chat.insertBeforeEditor(comp);
    }
    this.streamMd = comp;
    return comp;
  }

  setStopping(): void {
    this.loader?.setMessage('Stopping… (waiting for current step)');
    this.tui.requestRender();
  }

  private beginRun(
    sessionId: string,
    cwd: string,
    agentMd?: { path: string; chars: number; truncated: boolean },
    memory?: { profile_chars: number; requirements_chars: number; truncated: boolean },
    llm?: RunStartLlmMeta,
  ): void {
    this.streamBuffer = '';
    this.streamMd = null;
    this.toolPresenter.reset();

    this.loader = new CancellableLoader(
      this.tui,
      (s) => piChalk.cyan(s),
      (s) => piChalk.dim(s),
      'Running… (Esc to abort)',
    );
    this.loader.onAbort = () => this.onAbort?.();
    this.chat.insertBeforeEditor(this.loader);
    this.loader.start();

    this.appendRunMeta(`▶ task start  session=${sessionId}\n  cwd: ${cwd}`);
    if (agentMd) {
      const trunc = agentMd.truncated ? ', truncated' : '';
      this.appendRunMeta(`📋 ${agentMd.path} (${agentMd.chars} chars${trunc})`);
    }
    if (memory) {
      const total = memory.profile_chars + memory.requirements_chars;
      const trunc = memory.truncated ? ', truncated' : '';
      this.appendRunMeta(
        `🧠 memory: profile ${memory.profile_chars} + requirements ${memory.requirements_chars} = ${total} chars${trunc}`,
      );
    }
    if (llm) {
      this.appendRunMeta(`🤖 llm: ${formatRunStartLlmSummary(llm)}`);
    }
    this.tui.requestRender();
  }

  private endRun(reason: 'completed' | 'aborted' | 'error', message?: string): void {
    this.toolPresenter.reset();
    if (this.loader) {
      this.loader.stop();
      this.chat.remove(this.loader);
      this.loader = null;
    }
    this.streamMd = null;
    this.streamBuffer = '';

    if (reason === 'aborted') {
      this.chat.appendText('⊗ run aborted (session saved)', true);
    } else if (reason === 'error') {
      this.chat.appendText(`✗ run error: ${message ?? 'unknown'}`, true);
    } else {
      this.chat.appendText('✓ run completed', true);
    }
    this.tui.requestRender();
  }

  private handleAgentStep(event: AgentStepEvent): void {
    switch (event.type) {
      case 'turn_start':
        this.appendRunMeta(`[turn ${event.turn}] LLM`);
        break;
      case 'token': {
        this.streamBuffer += event.delta;
        this.ensureStreamMd().setText(this.streamBuffer);
        this.tui.requestRender();
        break;
      }
      case 'llm_done':
        if (event.finishReason !== 'tool_calls') {
          this.appendRunFooter(`finish=${event.finishReason ?? 'null'}`);
        }
        break;
      case 'llm_retry':
        this.appendRunMeta(formatLlmRetrySummary(event));
        break;
      case 'compression':
        this.appendRunMeta(
          event.pruned
            ? `📦 pruned ${event.pruned} messages`
            : event.pointer_compacted
              ? `📦 compacted ${event.pointer_compacted} pointer cards`
              : '📦 compression: summaries + replay',
        );
        break;
      case 'draft_discarded':
        this.appendRunMeta(`⊗ draft discarded (${event.chars} chars)`);
        break;
      case 'loop_guard':
        this.appendRunMeta(
          `🔄 loop_guard: ${event.action}${event.reason ? ` (${event.reason})` : ''}`,
        );
        break;
      case 'tool_plan':
        if (event.total >= 2) {
          this.appendRunMeta(formatToolPlanSummary(event));
        }
        break;
      case 'tool_batch':
        if (event.parallel > 1) {
          this.appendRunMeta(`⚡ parallel batch: ${event.parallel}/${event.total}`);
        }
        break;
      case 'tool_call':
        if (!this.toolPresenter.handleToolCall(event.call_id, event.name, event.args)) {
          // Generic tools stay silent in compact mode; failures surface on tool_result.
        }
        break;
      case 'tool_result': {
        const tier = toolDisplayTier(event.name);
        const failed = isToolFailure(event.name, event.output);
        const argsJson = event.args ?? '{}';

        if (tier === 'breadcrumb') {
          if (failed) {
            this.appendRunMeta(
              formatGenericToolFailureLine(event.name, event.output, event.preview),
            );
          } else {
            this.appendRunMeta(formatToolBreadcrumb(event.name, argsJson, event.output));
          }
          break;
        }

        const handled = this.toolPresenter.handleToolResult(
          event.call_id,
          event.name,
          event.output,
          event.display,
          event.args,
          { compact: tier === 'shell_fold' && !failed },
        );
        if (failed && !handled) {
          this.appendRunMeta(
            formatGenericToolFailureLine(event.name, event.output, event.preview),
          );
        }
        break;
      }
      case 'final': {
        const text = event.text;
        if (shouldFormatFinal(text)) {
          this.ensureStreamMd().setText(text);
        } else if (text.trim()) {
          this.ensureStreamMd().setText(text);
        }
        this.appendRunFooter(`[done @ turn ${event.turn}]`);
        this.streamMd = null;
        this.streamBuffer = '';
        this.tui.requestRender();
        break;
      }
    }
  }
}