import { Box, SelectList, Text, type SelectItem, type TUI } from '@earendil-works/pi-tui';

import { piChalk, piSelectListTheme } from './themes.js';

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
    let handle: { hide: () => void } | null = null;

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

    const panel = new Box(1, 1, (s) => piChalk.bgHex('#1e1e2e')(piChalk.white(s)));
    panel.addChild(new Text(title, 1, 1));
    const list = new SelectList(items, maxVisible, piSelectListTheme);

    list.onSelect = (item) => finish(item);
    list.onCancel = () => {
      if (!cancelable) return;
      finish(null);
    };

    panel.addChild(list);
    handle = tui.showOverlay(panel);
    tui.requestRender();
  });
}