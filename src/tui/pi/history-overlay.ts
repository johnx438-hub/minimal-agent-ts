import type { TUI } from '@earendil-works/pi-tui';

import { loadAction } from '../../action-store.js';
import {
  buildActionDetailLines,
  formatActionDetailTitle,
  listHistoryLines,
  listHistoryTasks,
  type HistoryLineEntry,
} from '../../session-history.js';
import type { SessionFile } from '../../types.js';
import { buildSelectItems, showPickerOverlay } from './picker.js';

function lineItems(entries: HistoryLineEntry[]) {
  if (entries.length === 0) {
    return buildSelectItems([
      {
        value: '__empty__',
        label: '(no history for this task)',
        description: 'Actions may not be in cold storage yet',
      },
    ]);
  }
  return buildSelectItems(
    entries.map((e) => ({
      value: e.value,
      label: e.label,
      description: e.description,
    })),
  );
}

async function showActionDetailOverlay(
  tui: TUI,
  actionId: string,
): Promise<void> {
  const block = loadAction(actionId);
  if (!block) {
    await showPickerOverlay(tui, {
      title: `Action not found: ${actionId}\nEsc back`,
      items: buildSelectItems([
        { value: 'missing', label: '(action file missing)', description: actionId },
      ]),
    });
    return;
  }

  const previewLines = buildActionDetailLines(block);
  const items = buildSelectItems(
    previewLines.map((line, i) => ({
      value: String(i),
      label: line.length > 76 ? `${line.slice(0, 75)}…` : line,
      description: '',
    })),
  );

  await showPickerOverlay(tui, {
    title: formatActionDetailTitle(block),
    items,
    maxVisible: Math.min(items.length, 12),
  });
}

async function showTaskHistoryOverlay(
  tui: TUI,
  session: SessionFile,
  taskId: string,
  taskLabel: string,
): Promise<void> {
  const entries = listHistoryLines(session, taskId);

  for (;;) {
    const picked = await showPickerOverlay(tui, {
      title: [
        `History · ${taskLabel}`,
        session.session_id,
        'Enter action detail · Esc back',
      ].join('\n'),
      items: lineItems(entries),
      maxVisible: Math.min(Math.max(entries.length, 1), 12),
    });

    if (!picked) return;

    const entry = entries.find((e) => e.value === picked.value);
    if (entry?.actionId) {
      await showActionDetailOverlay(tui, entry.actionId);
      continue;
    }
    if (entry?.kind === 'section') continue;
    return;
  }
}

export async function showHistoryBrowser(
  tui: TUI,
  session: SessionFile,
): Promise<void> {
  const tasks = listHistoryTasks(session);
  if (tasks.length === 0) {
    await showPickerOverlay(tui, {
      title: `History · ${session.session_id}\n(no tasks or in-flight context)`,
      items: buildSelectItems([
        { value: 'empty', label: '(empty session)', description: 'Run a task first' },
      ]),
    });
    return;
  }

  const taskItems = buildSelectItems(
    tasks.map((t) => ({
      value: t.taskId,
      label: t.label,
      description: t.description,
    })),
  );

  const picked = await showPickerOverlay(tui, {
    title: [
      `History · ${session.session_id}`,
      'Pick a task · Enter drill-down · Esc cancel',
    ].join('\n'),
    items: taskItems,
    maxVisible: Math.min(taskItems.length, 10),
  });

  if (!picked) return;

  const task = tasks.find((t) => t.taskId === picked.value);
  await showTaskHistoryOverlay(
    tui,
    session,
    picked.value,
    task?.label ?? picked.value,
  );
}