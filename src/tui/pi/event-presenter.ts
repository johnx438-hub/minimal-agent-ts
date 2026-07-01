import { CancellableLoader, type TUI } from '@earendil-works/pi-tui';

import type { AgentStepEvent, RuntimeEvent } from '../../events.js';
import { shouldFormatFinal } from '../markdown.js';
import type { PiChatLog } from './chat-log.js';
import { piChalk } from './themes.js';

function isAgentStep(event: RuntimeEvent): event is AgentStepEvent {
  return (
    event.type === 'turn_start' ||
    event.type === 'token' ||
    event.type === 'llm_done' ||
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
  private streamMd: ReturnType<PiChatLog['appendMarkdown']> | null = null;
  private loader: CancellableLoader | null = null;

  constructor(opts: PiEventPresenterOptions) {
    this.chat = opts.chat;
    this.tui = opts.tui;
    this.onAbort = opts.onAbort;
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
    }
  }

  private beginRun(sessionId: string, cwd: string): void {
    this.streamBuffer = '';
    this.streamMd = this.chat.appendMarkdown('');
    this.loader = new CancellableLoader(
      this.tui,
      (s) => piChalk.cyan(s),
      (s) => piChalk.dim(s),
      'Running… (Esc to abort)',
    );
    this.loader.onAbort = () => this.onAbort?.();
    this.chat.insertBeforeEditor(this.loader);
    this.loader.start();
    this.chat.appendText(`▶ task start  session=${sessionId}\n  cwd: ${cwd}`, true);
    this.tui.requestRender();
  }

  private endRun(reason: 'completed' | 'aborted' | 'error', message?: string): void {
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
        this.chat.appendText(`[turn ${event.turn}] LLM`, true);
        break;
      case 'token':
        this.streamBuffer += event.delta;
        this.streamMd?.setText(this.streamBuffer);
        this.tui.requestRender();
        break;
      case 'llm_done':
        this.chat.appendText(
          `finish=${event.finishReason ?? 'null'}`,
          true,
        );
        break;
      case 'compression':
        this.chat.appendText(
          event.pruned
            ? `📦 pruned ${event.pruned} messages`
            : '📦 compression: summaries + replay',
          true,
        );
        break;
      case 'draft_discarded':
        this.chat.appendText(`⊗ draft discarded (${event.chars} chars)`, true);
        break;
      case 'loop_guard':
        this.chat.appendText(
          `🔄 loop_guard: ${event.action}${event.reason ? ` (${event.reason})` : ''}`,
          true,
        );
        break;
      case 'tool_batch':
        if (event.parallel > 1) {
          this.chat.appendText(`⚡ parallel batch: ${event.parallel}/${event.total}`, true);
        }
        break;
      case 'tool_call':
        this.chat.appendText(`→ ${event.name}(${event.args})`, true);
        break;
      case 'tool_result': {
        const preview = event.preview ?? event.output;
        const shown = preview.length > 400 ? `${preview.slice(0, 400)}…` : preview;
        this.chat.appendText(`← ${event.name}: ${shown.replace(/\n/g, '\\n')}`, true);
        break;
      }
      case 'final': {
        const text = event.text;
        if (shouldFormatFinal(text)) {
          if (this.streamMd) {
            this.streamMd.setText(text);
          } else {
            this.chat.appendMarkdown(text);
          }
        } else if (text.trim()) {
          if (this.streamMd) {
            this.streamMd.setText(text);
          } else {
            this.chat.appendText(text);
          }
        }
        this.chat.appendText(`[done @ turn ${event.turn}]`, true);
        this.streamMd = null;
        this.streamBuffer = '';
        this.tui.requestRender();
        break;
      }
    }
  }
}