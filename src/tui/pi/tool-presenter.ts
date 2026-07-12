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
import { piMarkdownTheme, piSemantic } from './themes.js';

export interface PiToolPresenterOptions {
  chat: PiChatLog;
  tui: TUI;
  getAnchor: () => Component | null;
  /** Tiered display: write/edit rich, shell folded on success, breadcrumbs elsewhere. */
  compact?: boolean;
  getCwd?: () => string;
  getVerboseTools?: () => boolean;
}

export interface PiToolPresentOptions {
  /** When false, shell shows full stdout even on success. */
  compact?: boolean;
}

interface PendingToolCall {
  name: string;
  args: string;
  loader?: Loader;
}

/**
 * Rich pi-tui rendering for tool_call / tool_result.
 * Pairing uses call_id (parallel-safe); args on tool_result is the source of truth.
 */
export class PiToolPresenter {
  private readonly chat: PiChatLog;
  private readonly tui: TUI;
  private readonly getAnchor: () => Component | null;
  private readonly compact: boolean;
  private readonly getCwd?: () => string;
  private readonly getVerboseTools?: () => boolean;

  private readonly pending = new Map<string, PendingToolCall>();

  constructor(opts: PiToolPresenterOptions) {
    this.chat = opts.chat;
    this.tui = opts.tui;
    this.getAnchor = opts.getAnchor;
    this.compact = opts.compact ?? true;
    this.getCwd = opts.getCwd;
    this.getVerboseTools = opts.getVerboseTools;
  }

  reset(): void {
    for (const entry of this.pending.values()) {
      if (entry.loader) {
        entry.loader.stop();
        this.chat.remove(entry.loader);
      }
    }
    this.pending.clear();
  }

  /** @returns true if handled (caller should skip default rendering). */
  handleToolCall(callId: string, name: string, args: string, _opts?: PiToolPresentOptions): boolean {
    if (name === 'write_file') {
      this.pending.set(callId, { name, args });
      this.insertBeforeAnchor(
        new Text(formatWriteCallLine(args), 1, 0, piSemantic.metaLine),
      );
      this.tui.requestRender();
      return true;
    }

    if (name === 'edit_file') {
      this.pending.set(callId, { name, args });
      this.insertBeforeAnchor(
        new Text(formatEditCallLineFromArgs(parseEditArgs(args)), 1, 0, piSemantic.metaLine),
      );
      this.tui.requestRender();
      return true;
    }

    if (name !== 'run_shell') return false;

    const command = parseShellCommand(args);
    const cwd = this.getCwd?.();
    const loader = new Loader(
      this.tui,
      piSemantic.toolRunning,
      piSemantic.metaLine,
      formatShellLoaderMessage(command, cwd),
    );
    this.pending.set(callId, { name, args, loader });

    this.insertBeforeAnchor(
      new Text(formatShellCallLine(command, cwd), 1, 0, piSemantic.metaLine),
    );
    this.insertBeforeAnchor(loader);
    loader.start();
    this.tui.requestRender();
    return true;
  }

  /** @returns true if handled (caller should skip default rendering). */
  handleToolResult(
    callId: string,
    name: string,
    output: string,
    display?: string,
    args?: string,
    opts?: PiToolPresentOptions,
  ): boolean {
    const foldShell = (opts?.compact ?? this.compact);
    const pending = this.pending.get(callId);
    this.pending.delete(callId);
    const argsJson = args ?? pending?.args ?? '{}';

    if (name === 'write_file') {
      const parts = buildWriteDisplayParts(argsJson, output, display);
      const ok = parts.status === 'ok';
      this.insertBeforeAnchor(
        new Text(formatWriteSummaryLine(parts), 1, 0, ok ? piSemantic.toolOk : piSemantic.toolErr),
      );
      this.insertBeforeAnchor(
        new Markdown(formatWriteResultMarkdown(parts), 1, 1, piMarkdownTheme),
      );
      this.tui.requestRender();
      return true;
    }

    if (name === 'edit_file') {
      const parts = buildEditDisplayParts(argsJson, output, display);
      const ok = !String(output).trim().startsWith('error:');
      this.insertBeforeAnchor(
        new Text(formatEditSummaryLine(parts), 1, 0, ok ? piSemantic.toolOk : piSemantic.toolErr),
      );
      this.insertBeforeAnchor(new Markdown(formatEditResultMarkdown(parts), 1, 1, piMarkdownTheme));
      this.tui.requestRender();
      return true;
    }

    if (name !== 'run_shell') return false;

    const loader = pending?.loader;
    if (loader) {
      loader.stop();
      this.chat.remove(loader);
    }

    const parts = buildShellDisplayParts(argsJson, output, {
      cwd: this.getCwd?.(),
      verboseTools: this.getVerboseTools?.() === true,
    });
    const showBody = !foldShell || parts.status !== 'ok';
    const ok = parts.status === 'ok';
    this.insertBeforeAnchor(
      new Text(formatShellSummaryLine(parts), 1, 0, ok ? piSemantic.toolOk : piSemantic.toolErr),
    );
    if (showBody) {
      this.insertBeforeAnchor(new Markdown(formatShellResultMarkdown(parts), 1, 1, piMarkdownTheme));
    }
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