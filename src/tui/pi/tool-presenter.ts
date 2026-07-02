import { Loader, Markdown, Text, type Component, type TUI } from '@earendil-works/pi-tui';

import {
  buildShellDisplayParts,
  formatShellCallLine,
  formatShellLoaderMessage,
  formatShellResultMarkdown,
  formatShellSummaryLine,
  parseShellCommand,
} from './shell-display.js';
import type { PiChatLog } from './chat-log.js';
import { piChalk, piMarkdownTheme } from './themes.js';

export interface PiToolPresenterOptions {
  chat: PiChatLog;
  tui: TUI;
  getAnchor: () => Component | null;
}

/**
 * Rich pi-tui rendering for tool_call / tool_result (step 1: run_shell).
 * Other tools fall through to the default one-line presenter.
 */
export class PiToolPresenter {
  private readonly chat: PiChatLog;
  private readonly tui: TUI;
  private readonly getAnchor: () => Component | null;

  /** FIFO queue — run_shell is serial-only in the scheduler. */
  private readonly shellArgsQueue: string[] = [];
  private readonly shellLoaders: Loader[] = [];

  constructor(opts: PiToolPresenterOptions) {
    this.chat = opts.chat;
    this.tui = opts.tui;
    this.getAnchor = opts.getAnchor;
  }

  reset(): void {
    for (const loader of this.shellLoaders) {
      loader.stop();
      this.chat.remove(loader);
    }
    this.shellLoaders.length = 0;
    this.shellArgsQueue.length = 0;
  }

  /** @returns true if handled (caller should skip default rendering). */
  handleToolCall(name: string, args: string): boolean {
    if (name !== 'run_shell') return false;

    this.shellArgsQueue.push(args);
    const command = parseShellCommand(args);

    this.insertBeforeAnchor(
      new Text(formatShellCallLine(command), 1, 0, (s) => piChalk.dim(s)),
    );

    const loader = new Loader(
      this.tui,
      (s) => piChalk.cyan(s),
      (s) => piChalk.dim(s),
      formatShellLoaderMessage(command),
    );
    this.insertBeforeAnchor(loader);
    loader.start();
    this.shellLoaders.push(loader);
    this.tui.requestRender();
    return true;
  }

  /** @returns true if handled (caller should skip default rendering). */
  handleToolResult(name: string, output: string): boolean {
    if (name !== 'run_shell') return false;

    const args = this.shellArgsQueue.shift() ?? '{}';
    const loader = this.shellLoaders.shift();
    if (loader) {
      loader.stop();
      this.chat.remove(loader);
    }

    const parts = buildShellDisplayParts(args, output);
    this.insertBeforeAnchor(
      new Text(formatShellSummaryLine(parts), 1, 0, (s) => piChalk.dim(s)),
    );
    this.insertBeforeAnchor(new Markdown(formatShellResultMarkdown(parts), 1, 1, piMarkdownTheme));
    this.tui.requestRender();
    return true;
  }

  private insertBeforeAnchor(component: Component): void {
    const anchor = this.getAnchor();
    if (anchor) {
      this.chat.insertBefore(component, anchor);
    } else {
      this.chat.insertBeforeEditor(component);
    }
  }
}