import { CancellableLoader, Markdown, Text, type TUI } from '@earendil-works/pi-tui';

import {
  formatActionFlushSummary,
  formatTurnIoSummary,
  isActionIoMetricsEnabled,
} from '../../action-io-metrics.js';
import {
  formatCompressionSummary,
  formatLlmFallbackSummary,
  formatLlmRetrySummary,
  formatToolPlanSummary,
  type AgentStepEvent,
  type RunStartLlmMeta,
  type RuntimeEvent,
} from '../../events.js';
import { shouldFormatFinal } from './final-text.js';
import type { PiChatLog } from './chat-log.js';
import { formatRunStartLines, shouldShowIoMetric } from './run-header.js';
import { piMarkdownTheme, piSemantic, type TextStyler } from './themes.js';
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
    event.type === 'llm_fallback' ||
    event.type === 'tool_plan' ||
    event.type === 'tool_batch' ||
    event.type === 'tool_call' ||
    event.type === 'tool_result' ||
    event.type === 'compression' ||
    event.type === 'draft_discarded' ||
    event.type === 'loop_guard' ||
    event.type === 'turn_io' ||
    event.type === 'final'
  );
}

/** Display density flags (SPEC_TUI_POLISH). */
export interface PiPresenterDisplayPrefs {
  verbose_turns?: boolean;
  verbose_io?: boolean;
  verbose_run_header?: boolean;
  verbose_tools?: boolean;
}

export interface PiEventPresenterOptions {
  chat: PiChatLog;
  tui: TUI;
  onAbort?: () => void;
  /** Working directory for shell command display compression. */
  getCwd?: () => string;
  /** Live prefs reader (defaults compact). */
  getDisplayPrefs?: () => PiPresenterDisplayPrefs;
  /** Optional: notify parent of turn number for status bar. */
  onTurn?: (turn: number) => void;
}

export class PiEventPresenter {
  private readonly chat: PiChatLog;
  private readonly tui: TUI;
  private readonly onAbort?: () => void;
  private readonly getCwd?: () => string;
  private readonly getDisplayPrefs?: () => PiPresenterDisplayPrefs;
  private readonly onTurn?: (turn: number) => void;

  private streamBuffer = '';
  private streamMd: Markdown | null = null;
  private loader: CancellableLoader | null = null;
  private readonly toolPresenter: PiToolPresenter;
  private lastTurn = 0;

  constructor(opts: PiEventPresenterOptions) {
    this.chat = opts.chat;
    this.tui = opts.tui;
    this.onAbort = opts.onAbort;
    this.getCwd = opts.getCwd;
    this.getDisplayPrefs = opts.getDisplayPrefs;
    this.onTurn = opts.onTurn;
    this.toolPresenter = new PiToolPresenter({
      chat: this.chat,
      tui: this.tui,
      getAnchor: () => this.streamMd ?? this.loader,
      getCwd: opts.getCwd,
      getVerboseTools: () => this.prefs().verbose_tools === true,
    });
  }

  private prefs(): PiPresenterDisplayPrefs {
    return this.getDisplayPrefs?.() ?? {};
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
        this.appendStyled(`💾 session saved (${event.task_count} tasks)`, piSemantic.metaLine);
        break;
      case 'runtime':
        this.appendStyled(
          `⚙ shell:${event.shell ? 'on' : 'off'} web:${event.web ? 'on' : 'off'}`,
          piSemantic.metaLine,
        );
        break;
      case 'permission_prompt_start':
        this.appendRunMeta(`permission ▶ ${event.kind} (${event.reason})`);
        break;
      case 'permission_prompt_end':
        this.appendRunMeta(
          `permission ${event.approved ? '✓' : '⊗'} ${event.kind} (${event.reason})`,
          event.approved ? piSemantic.toolOk : piSemantic.toolErr,
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
          event.approved ? piSemantic.toolOk : piSemantic.toolErr,
        );
        break;
      case 'workflow_step': {
        const round = event.round !== undefined ? ` round ${event.round}` : '';
        this.appendStyled(`workflow ▶ ${event.phase} / ${event.role}${round}`, piSemantic.metaLine);
        break;
      }
      case 'workflow_handback': {
        const round = event.round !== undefined ? ` round ${event.round}` : '';
        const role = event.role ? `  role: ${event.role}${round}\n` : '';
        this.appendStyled(
          `workflow handback ▶ ${event.workflow} (${event.reason})\n${role}  ${event.detail}`,
          piSemantic.accent,
        );
        break;
      }
      case 'spawn_start':
        this.appendRunMeta(`spawn ▶ ${event.preset}`);
        break;
      case 'spawn_end':
        if (event.ok) {
          this.appendRunMeta(`spawn ✓ ${event.preset}`, piSemantic.toolOk);
        } else {
          this.appendRunMeta(
            `spawn ✗ ${event.preset}${event.detail ? `: ${event.detail}` : ''}`,
            piSemantic.toolErr,
          );
        }
        break;
      case 'action_flush':
        if (
          isActionIoMetricsEnabled() &&
          shouldShowIoMetric({
            verboseIo: this.prefs().verbose_io === true,
            pending: event.pending,
            flushMs: event.flush_ms,
          })
        ) {
          this.appendRunMeta(`💾 ${formatActionFlushSummary(event)}`);
        }
        break;
    }
  }

  private appendStyled(text: string, styler: TextStyler): void {
    const comp = new Text(text, 1, 0, styler);
    this.chat.insertBeforeEditor(comp);
  }

  /** Tool / turn meta — always above the streaming LLM block. */
  private appendRunMeta(text: string, styler: TextStyler = piSemantic.metaLine): void {
    const comp = new Text(text, 1, 0, styler);
    const anchor = this.streamMd ?? this.loader;
    if (anchor) {
      this.chat.insertBefore(comp, anchor);
    } else {
      this.chat.insertBeforeEditor(comp);
    }
  }

  /** Status after the reply block (e.g. [done], finish reason). */
  private appendRunFooter(text: string, styler: TextStyler = piSemantic.metaLine): void {
    const comp = new Text(text, 1, 0, styler);
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
    this.lastTurn = 0;
    this.toolPresenter.reset();

    this.loader = new CancellableLoader(
      this.tui,
      piSemantic.toolRunning,
      piSemantic.metaLine,
      'Running… (Esc → confirm stop)',
    );
    this.loader.onAbort = () => this.onAbort?.();
    this.chat.insertBeforeEditor(this.loader);
    this.loader.start();

    const lines = formatRunStartLines({
      sessionId,
      cwd,
      agentMd,
      memory,
      llm,
      verbose: this.prefs().verbose_run_header === true,
    });
    for (const line of lines) {
      this.appendRunMeta(line);
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
      this.appendStyled('⊗ run aborted (session saved)', piSemantic.statusErr);
    } else if (reason === 'error') {
      this.appendStyled(`✗ run error: ${message ?? 'unknown'}`, piSemantic.statusErr);
    } else {
      this.appendStyled('✓ run completed', piSemantic.statusOk);
    }
    this.tui.requestRender();
  }

  private handleAgentStep(event: AgentStepEvent): void {
    switch (event.type) {
      case 'turn_start':
        this.lastTurn = event.turn;
        this.onTurn?.(event.turn);
        if (this.prefs().verbose_turns) {
          this.appendRunMeta(`[turn ${event.turn}] LLM`);
        }
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
        this.appendRunMeta(formatLlmRetrySummary(event), piSemantic.accent);
        break;
      case 'llm_fallback':
        this.appendRunMeta(formatLlmFallbackSummary(event), piSemantic.accent);
        break;
      case 'compression':
        this.appendRunMeta(formatCompressionSummary(event), piSemantic.accent);
        break;
      case 'draft_discarded':
        this.appendRunMeta(`⊗ draft discarded (${event.chars} chars)`, piSemantic.toolErr);
        break;
      case 'loop_guard':
        this.appendRunMeta(
          `🔄 loop_guard: ${event.action}${event.reason ? ` (${event.reason})` : ''}`,
          piSemantic.accent,
        );
        break;
      case 'turn_io':
        if (
          isActionIoMetricsEnabled() &&
          shouldShowIoMetric({
            verboseIo: this.prefs().verbose_io === true,
            pending: event.queue_depth,
            flushMs: event.action_save_ms,
          })
        ) {
          this.appendRunMeta(`💾 ${formatTurnIoSummary(event)}`);
        }
        break;
      case 'tool_plan':
        if (event.total >= 2) {
          this.appendRunMeta(formatToolPlanSummary(event));
        }
        break;
      case 'tool_batch':
        if (event.parallel > 1) {
          this.appendRunMeta(`⚡ parallel batch: ${event.parallel}/${event.total}`, piSemantic.accent);
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
              piSemantic.toolErr,
            );
          } else {
            this.appendRunMeta(
              formatToolBreadcrumb(event.name, argsJson, event.output),
              piSemantic.toolOk,
            );
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
            piSemantic.toolErr,
          );
        }
        break;
      }
      case 'final': {
        const text = event.text;
        if (shouldFormatFinal(text) || text.trim()) {
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
