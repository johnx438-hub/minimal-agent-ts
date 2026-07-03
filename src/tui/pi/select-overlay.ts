import {
  Box,
  SelectList,
  Text,
  type Component,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui';

import { piChalk, piSelectListTheme } from './themes.js';

/** Box wrapper that forwards keyboard input to an embedded SelectList. */
class SelectOverlayPanel implements Component {
  private readonly box: Box;
  private readonly list: SelectList;

  constructor(title: string, list: SelectList, bgFn: (s: string) => string) {
    this.list = list;
    this.box = new Box(1, 1, bgFn);
    this.box.addChild(new Text(title, 1, 1));
    this.box.addChild(list);
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.box.invalidate();
  }

  render(width: number): string[] {
    return this.box.render(width);
  }
}

export function showSelectOverlay(
  tui: TUI,
  title: string,
  items: SelectItem[],
  opts?: { maxVisible?: number; cancelable?: boolean; abortSignal?: AbortSignal },
): Promise<SelectItem | null> {
  const cancelable = opts?.cancelable !== false;
  const maxVisible = opts?.maxVisible ?? Math.min(items.length, 8);
  const abortSignal = opts?.abortSignal;

  return new Promise((resolve) => {
    let settled = false;
    let handle: { hide: () => void; focus?: () => void } | null = null;

    const finish = (item: SelectItem | null): void => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', onAbort);
      handle?.hide();
      resolve(item);
    };

    const onAbort = (): void => finish(null);
    if (abortSignal?.aborted) {
      finish(null);
      return;
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    const list = new SelectList(items, maxVisible, piSelectListTheme);

    list.onSelect = (item) => finish(item);
    list.onCancel = () => {
      if (!cancelable) return;
      finish(null);
    };

    const panel = new SelectOverlayPanel(
      title,
      list,
      (s) => piChalk.bgHex('#1e1e2e')(piChalk.white(s)),
    );
    handle = tui.showOverlay(panel);
    handle.focus?.();
    tui.requestRender();
  });
}