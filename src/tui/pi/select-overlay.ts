import { Box, SelectList, Text, type SelectItem, type TUI } from '@earendil-works/pi-tui';

import { piChalk, piSelectListTheme } from './themes.js';

export function showSelectOverlay(
  tui: TUI,
  title: string,
  items: SelectItem[],
  opts?: { maxVisible?: number; cancelable?: boolean },
): Promise<SelectItem | null> {
  const cancelable = opts?.cancelable !== false;
  const maxVisible = opts?.maxVisible ?? Math.min(items.length, 8);

  return new Promise((resolve) => {
    const panel = new Box(1, 1, (s) => piChalk.bgHex('#1e1e2e')(piChalk.white(s)));
    panel.addChild(new Text(title, 1, 1));
    const list = new SelectList(items, maxVisible, piSelectListTheme);

    list.onSelect = (item) => {
      handle.hide();
      resolve(item);
    };
    list.onCancel = () => {
      if (!cancelable) return;
      handle.hide();
      resolve(null);
    };

    panel.addChild(list);
    const handle = tui.showOverlay(panel);
    tui.requestRender();
  });
}