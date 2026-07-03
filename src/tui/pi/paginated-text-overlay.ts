import {
  Box,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';

import { piChalk, piOverlayBgHex } from './themes.js';
import {
  clampLineOffset,
  formatScrollFooter,
  pageOffset,
} from './text-pagination.js';

const DEFAULT_VISIBLE_LINES = 10;
const HORIZONTAL_PADDING = 2;

function paintOverlayLine(line: string, width: number): string {
  const fitted = truncateToWidth(line, width, '', true);
  return piChalk.bgHex(piOverlayBgHex)(piChalk.white(fitted));
}

export interface PaginatedTextOverlayOptions {
  title: string;
  body: string;
  /** Lines visible in the scroll viewport (default 10). */
  visibleLines?: number;
}

class PaginatedTextPanel implements Component {
  private readonly box = new Box(1, 1);
  private readonly titleText: Text;
  private readonly bodyText: Text;
  private readonly footerText: Text;
  private readonly rawBody: string;
  private readonly visibleLines: number;
  private readonly onClose: () => void;
  private readonly requestRender: () => void;

  private offset = 0;
  private lastWidth = 0;
  private wrappedLines: string[] = ['(empty)'];

  constructor(
    opts: PaginatedTextOverlayOptions,
    onClose: () => void,
    requestRender: () => void,
  ) {
    this.rawBody = opts.body;
    this.visibleLines = opts.visibleLines ?? DEFAULT_VISIBLE_LINES;
    this.onClose = onClose;
    this.requestRender = requestRender;

    this.titleText = new Text(opts.title, 1, 0);
    this.bodyText = new Text('', 1, 0);
    this.footerText = new Text('', 1, 0, (s) => piChalk.dim(s));

    this.box.addChild(this.titleText);
    this.box.addChild(this.bodyText);
    this.box.addChild(this.footerText);
    this.refreshContent(80);
  }

  private contentWidth(terminalWidth: number): number {
    return Math.max(20, terminalWidth - HORIZONTAL_PADDING);
  }

  private rewrap(terminalWidth: number): void {
    const width = this.contentWidth(terminalWidth);
    const text = this.rawBody.trimEnd();
    this.wrappedLines =
      text.length > 0 ? wrapTextWithAnsi(text, width) : ['(empty)'];
    this.offset = clampLineOffset(
      this.offset,
      this.wrappedLines.length,
      this.visibleLines,
    );
  }

  private refreshContent(terminalWidth: number): void {
    if (terminalWidth !== this.lastWidth) {
      this.lastWidth = terminalWidth;
      this.rewrap(terminalWidth);
    }

    const slice = this.wrappedLines.slice(
      this.offset,
      this.offset + this.visibleLines,
    );
    this.bodyText.setText(slice.join('\n'));
    this.footerText.setText(
      formatScrollFooter(
        this.offset,
        this.wrappedLines.length,
        this.visibleLines,
      ),
    );
  }

  private bump(delta: number): void {
    this.offset = clampLineOffset(
      this.offset + delta,
      this.wrappedLines.length,
      this.visibleLines,
    );
    this.refreshContent(this.lastWidth || 80);
    this.requestRender();
  }

  private page(direction: -1 | 1): void {
    this.offset = pageOffset(
      this.offset,
      this.wrappedLines.length,
      this.visibleLines,
      direction,
    );
    this.refreshContent(this.lastWidth || 80);
    this.requestRender();
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.return)
    ) {
      this.onClose();
      return;
    }

    if (
      matchesKey(data, Key.left) ||
      matchesKey(data, 'h') ||
      matchesKey(data, Key.pageUp)
    ) {
      this.page(-1);
      return;
    }

    if (
      matchesKey(data, Key.right) ||
      matchesKey(data, 'l') ||
      matchesKey(data, Key.pageDown)
    ) {
      this.page(1);
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, 'k')) {
      this.bump(-1);
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, 'j')) {
      this.bump(1);
      return;
    }

    if (matchesKey(data, Key.home)) {
      this.offset = 0;
      this.refreshContent(this.lastWidth || 80);
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.end)) {
      this.offset = clampLineOffset(
        Number.MAX_SAFE_INTEGER,
        this.wrappedLines.length,
        this.visibleLines,
      );
      this.refreshContent(this.lastWidth || 80);
      this.requestRender();
    }
  }

  invalidate(): void {
    this.box.invalidate();
  }

  render(width: number): string[] {
    this.refreshContent(width);
    return this.box.render(width).map((line) => paintOverlayLine(line, width));
  }
}

export function showPaginatedTextOverlay(
  tui: TUI,
  opts: PaginatedTextOverlayOptions,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let handle: { hide: () => void; focus?: () => void } | null = null;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      handle?.hide();
      resolve();
    };

    const panel = new PaginatedTextPanel(opts, finish, () => tui.requestRender());
    handle = tui.showOverlay(panel);
    handle.focus?.();
    tui.requestRender();
  });
}