import { CancellableLoader, Markdown, Text, type TUI } from '@earendil-works/pi-tui';

import {
  formatLlmRetrySummary,
  formatToolPlanSummary,
  type AgentStepEvent,
  type RuntimeEvent,
} from '../../events.js';
import { shouldFormatFinal } from '../markdown.js';
import type { PiChatLog } from './chat-log.js';
import { piChalk, piMarkdownTheme } from './themes.js';
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
        this.beginRun(event.session_id, event.cwd);
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

  private beginRun(sessionId: string, cwd: string): void {
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
        this.appendRunFooter(`finish=${event.finishReason ?? 'null'}`);
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
        if (!this.toolPresenter.handleToolCall(event.name, event.args)) {
          this.appendRunMeta(`→ ${event.name}(${event.args})`);
        }
        break;
      case 'tool_result': {
        if (!this.toolPresenter.handleToolResult(event.name, event.output)) {
          const preview = event.preview ?? event.output;
          const shown = preview.length > 400 ? `${preview.slice(0, 400)}…` : preview;
          this.appendRunMeta(`← ${event.name}: ${shown.replace(/\n/g, '\\n')}`);
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