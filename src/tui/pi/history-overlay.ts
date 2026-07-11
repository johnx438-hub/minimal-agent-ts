import type { TUI } from '@earendil-works/pi-tui';

import {
  listHistoryLines,
  listHistoryTasks,
  type HistoryLineEntry,
} from '../../session-history.js';
import type { SessionFile } from '../../types.js';
import { showPaginatedTextOverlay } from './paginated-text-overlay.js';
import { buildSelectItems, showPickerOverlay } from './picker.js';
import { showActionDetailOverlay } from './log-overlay.js';

function lineItems(entries: HistoryLineEntry[]) {
  if (entries.length === 0) {
    return buildSelectItems([
      {
        value: '__empty__',
        label: '(no messages for this task)',
        description: 'Transcript may not exist for legacy tasks',
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

async function showMessageDetailOverlay(
  tui: TUI,
  entry: HistoryLineEntry,
): Promise<void> {
  const body = entry.body ?? entry.description;
  const label = entry.kind === 'user' ? 'User message' : 'Assistant message';
  await showPaginatedTextOverlay(tui, {
    title: label,
    body,
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
        `Transcript · ${taskLabel}`,
        session.session_id,
        'Enter message/action · Esc back',
      ].join('\n'),
      items: lineItems(entries),
      maxVisible: Math.min(Math.max(entries.length, 1), 12),
    });

    if (!picked) return;

    const entry = entries.find((e) => e.value === picked.value);
    if (!entry || entry.kind === 'section') continue;

    if (entry.kind === 'tool' && entry.actionId) {
      await showActionDetailOverlay(tui, entry.actionId);
      continue;
    }

    if ((entry.kind === 'user' || entry.kind === 'assistant') && entry.body) {
      await showMessageDetailOverlay(tui, entry);
      continue;
    }

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
      title: `Transcript · ${session.session_id}\n(no tasks or messages)`,
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
      `Transcript · ${session.session_id}`,
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