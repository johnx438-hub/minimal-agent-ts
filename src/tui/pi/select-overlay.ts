import {
  Box,
  SelectList,
  Text,
  truncateToWidth,
  type Component,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui';

import { popOverlay, pushOverlay } from './overlay-stack.js';
import { piChalk, piOverlayBgHex, piSelectListOverlayTheme } from './themes.js';

export type PickerFinish = (item: SelectItem | null) => void;

export type PickerKeyContext = {
  getSelectedItem: () => SelectItem | undefined;
  finish: PickerFinish;
};

export type PickerKeyHandler = (
  key: string,
  ctx: PickerKeyContext,
) => boolean | void | Promise<boolean | void>;

function paintOverlayLine(line: string, width: number): string {
  const fitted = truncateToWidth(line, width, '', true);
  return piChalk.bgHex(piOverlayBgHex)(piChalk.white(fitted));
}

/** Box wrapper that forwards keyboard input to an embedded SelectList. */
class SelectOverlayPanel implements Component {
  private readonly box: Box;
  private readonly list: SelectList;
  private readonly onInfo?: (item: SelectItem, finish: PickerFinish) => void | Promise<void>;
  private readonly onKey?: PickerKeyHandler;
  private readonly finishPicker: PickerFinish;

  constructor(
    title: string,
    list: SelectList,
    finishPicker: PickerFinish,
    onInfo?: (item: SelectItem, finish: PickerFinish) => void | Promise<void>,
    onKey?: PickerKeyHandler,
  ) {
    this.list = list;
    this.finishPicker = finishPicker;
    this.onInfo = onInfo;
    this.onKey = onKey;
    this.box = new Box(1, 1);
    this.box.addChild(new Text(title, 1, 1));
    this.box.addChild(list);
  }

  handleInput(data: string): void {
    if (this.onKey) {
      const handled = this.onKey(data, {
        getSelectedItem: () => this.list.getSelectedItem() ?? undefined,
        finish: this.finishPicker,
      });
      if (handled instanceof Promise) {
        void handled.then((result) => {
          if (result) return;
          this.forwardToList(data);
        });
        return;
      }
      if (handled) return;
    }
    this.forwardToList(data);
  }

  private forwardToList(data: string): void {
    if (this.onInfo && data === 'i') {
      const item = this.list.getSelectedItem();
      if (item) void this.onInfo(item, this.finishPicker);
      return;
    }
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.box.invalidate();
  }

  render(width: number): string[] {
    return this.box.render(width).map((line) => paintOverlayLine(line, width));
  }
}

export function showSelectOverlay(
  tui: TUI,
  title: string,
  items: SelectItem[],
  opts?: {
    maxVisible?: number;
    cancelable?: boolean;
    abortSignal?: AbortSignal;
    onInfo?: (item: SelectItem, finish: PickerFinish) => void | Promise<void>;
    onKey?: PickerKeyHandler;
  },
): Promise<SelectItem | null> {
  const cancelable = opts?.cancelable !== false;
  const maxVisible = opts?.maxVisible ?? Math.min(items.length, 8);
  const abortSignal = opts?.abortSignal;

  return new Promise((resolve) => {
    let settled = false;
    let handle: { hide: () => void; focus?: () => void } | null = null;
    let stacked = false;

    const finish = (item: SelectItem | null): void => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', onAbort);
      handle?.hide();
      if (stacked) {
        popOverlay();
        stacked = false;
      }
      resolve(item);
    };

    const onAbort = (): void => finish(null);
    if (abortSignal?.aborted) {
      finish(null);
      return;
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    const list = new SelectList(items, maxVisible, piSelectListOverlayTheme);

    list.onSelect = (item) => finish(item);
    list.onCancel = () => {
      if (!cancelable) return;
      finish(null);
    };

    const panel = new SelectOverlayPanel(title, list, finish, opts?.onInfo, opts?.onKey);
    pushOverlay();
    stacked = true;
    handle = tui.showOverlay(panel);
    handle.focus?.();
    tui.requestRender();
  });
}