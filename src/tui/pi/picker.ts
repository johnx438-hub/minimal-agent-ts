import type { SelectItem, TUI } from '@earendil-works/pi-tui';

import { showSelectOverlay, type PickerFinish } from './select-overlay.js';

export type { PickerFinish };

export interface PickerEntry {
  value: string;
  label: string;
  description?: string;
}

export function buildSelectItems(entries: PickerEntry[]): SelectItem[] {
  return entries.map((e) => ({
    value: e.value,
    label: e.label,
    description: e.description,
  }));
}

export interface PickerOverlayOptions {
  title: string;
  items: SelectItem[];
  maxVisible?: number;
  cancelable?: boolean;
  abortSignal?: AbortSignal;
  /** Called when user presses i on the highlighted row (session info, etc.). */
  onInfo?: (item: SelectItem, finish: PickerFinish) => void | Promise<void>;
}

export function showPickerOverlay(
  tui: TUI,
  opts: PickerOverlayOptions,
): Promise<SelectItem | null> {
  const { title, items, maxVisible, cancelable, abortSignal, onInfo } = opts;
  return showSelectOverlay(tui, title, items, {
    maxVisible,
    cancelable,
    abortSignal,
    onInfo,
  });
}