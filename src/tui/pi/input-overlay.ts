/**
 * Single-line text prompt overlay (session notes, etc.).
 */

import {
  Box,
  Input,
  Text,
  truncateToWidth,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';

import { popOverlay, pushOverlay } from './overlay-stack.js';
import { piChalk, piOverlayBgHex } from './themes.js';

function paintOverlayLine(line: string, width: number): string {
  const fitted = truncateToWidth(line, width, '', true);
  return piChalk.bgHex(piOverlayBgHex)(piChalk.white(fitted));
}

class InputOverlayPanel implements Component {
  private readonly box: Box;
  private readonly input: Input;

  constructor(title: string, input: Input) {
    this.input = input;
    this.box = new Box(1, 1);
    this.box.addChild(new Text(title, 1, 1));
    this.box.addChild(input);
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {
    this.box.invalidate();
  }

  render(width: number): string[] {
    return this.box.render(width).map((line) => paintOverlayLine(line, width));
  }
}

export interface InputOverlayOptions {
  /** Pre-filled value. */
  initial?: string;
  abortSignal?: AbortSignal;
}

/**
 * Modal single-line input. Enter submits (may be empty); Esc cancels (null).
 */
export function showInputOverlay(
  tui: TUI,
  title: string,
  opts?: InputOverlayOptions,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let handle: { hide: () => void; focus?: () => void } | null = null;
    let stacked = false;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      opts?.abortSignal?.removeEventListener('abort', onAbort);
      handle?.hide();
      if (stacked) {
        popOverlay();
        stacked = false;
      }
      resolve(value);
    };

    const onAbort = (): void => finish(null);
    if (opts?.abortSignal?.aborted) {
      finish(null);
      return;
    }
    opts?.abortSignal?.addEventListener('abort', onAbort, { once: true });

    const input = new Input();
    if (opts?.initial) input.setValue(opts.initial);
    input.onSubmit = (value) => finish(value);
    input.onEscape = () => finish(null);

    const panel = new InputOverlayPanel(title, input);
    pushOverlay();
    stacked = true;
    handle = tui.showOverlay(panel);
    handle.focus?.();
    tui.requestRender();
  });
}
