import { Loader, Markdown, Text, type Component, type TUI } from '@earendil-works/pi-tui';

import {
  buildEditDisplayParts,
  formatEditCallLineFromArgs,
  formatEditResultMarkdown,
  formatEditSummaryLine,
  parseEditArgs,
} from './edit-display.js';
import {
  buildShellDisplayParts,
  formatShellCallLine,
  formatShellLoaderMessage,
  formatShellResultMarkdown,
  formatShellSummaryLine,
  parseShellCommand,
} from './shell-display.js';
import {
  buildWriteDisplayParts,
  formatWriteCallLine,
  formatWriteResultMarkdown,
  formatWriteSummaryLine,
} from './write-display.js';
import type { PiChatLog } from './chat-log.js';
import { piChalk, piMarkdownTheme } from './themes.js';

export interface PiToolPresenterOptions {
  chat: PiChatLog;
  tui: TUI;
  getAnchor: () => Component | null;
}

/**
 * Rich pi-tui rendering for tool_call / tool_result.
 * Steps 1–3: run_shell, edit_file, write_file rich display.
 * Other tools fall through to the default one-line presenter.
 */
export class PiToolPresenter {
  private readonly chat: PiChatLog;
  private readonly tui: TUI;
  private readonly getAnchor: () => Component | null;

  /** FIFO queues — serial-only tools in the scheduler. */
  private readonly shellArgsQueue: string[] = [];
  private readonly shellLoaders: Loader[] = [];
  private readonly editArgsQueue: string[] = [];
  private readonly writeArgsQueue: string[] = [];

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
    this.editArgsQueue.length = 0;
    this.writeArgsQueue.length = 0;
  }

  /** @returns true if handled (caller should skip default rendering). */
  handleToolCall(name: string, args: string): boolean {
    if (name === 'write_file') {
      this.writeArgsQueue.push(args);
      this.insertBeforeAnchor(
        new Text(formatWriteCallLine(args), 1, 0, (s) => piChalk.dim(s)),
      );
      this.tui.requestRender();
      return true;
    }

    if (name === 'edit_file') {
      this.editArgsQueue.push(args);
      this.insertBeforeAnchor(
        new Text(formatEditCallLineFromArgs(parseEditArgs(args)), 1, 0, (s) => piChalk.dim(s)),
      );
      this.tui.requestRender();
      return true;
    }

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
  handleToolResult(name: string, output: string, display?: string): boolean {
    if (name === 'write_file') {
      const args = this.writeArgsQueue.shift() ?? '{}';
      const parts = buildWriteDisplayParts(args, output, display);
      this.insertBeforeAnchor(
        new Text(formatWriteSummaryLine(parts), 1, 0, (s) => piChalk.dim(s)),
      );
      this.insertBeforeAnchor(
        new Markdown(formatWriteResultMarkdown(parts), 1, 1, piMarkdownTheme),
      );
      this.tui.requestRender();
      return true;
    }

    if (name === 'edit_file') {
      const args = this.editArgsQueue.shift() ?? '{}';
      const parts = buildEditDisplayParts(args, output);
      this.insertBeforeAnchor(
        new Text(formatEditSummaryLine(parts), 1, 0, (s) => piChalk.dim(s)),
      );
      this.insertBeforeAnchor(new Markdown(formatEditResultMarkdown(parts), 1, 1, piMarkdownTheme));
      this.tui.requestRender();
      return true;
    }

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