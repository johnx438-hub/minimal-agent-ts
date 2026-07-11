import type { TUI } from '@earendil-works/pi-tui';

import { loadAction } from '../../action-store.js';
import {
  buildActionDetailLines,
  formatActionDetailTitle,
  listLogLines,
  listLogTasks,
  type LogLineEntry,
} from '../../session-log.js';
import type { ActionBlock, SessionFile } from '../../types.js';
import { showPaginatedTextOverlay } from './paginated-text-overlay.js';
import { buildSelectItems, showPickerOverlay } from './picker.js';

function actionDetailBody(block: ActionBlock): string {
  if (block.result_text?.trim()) return block.result_text;
  return buildActionDetailLines(block).join('\n');
}

function lineItems(entries: LogLineEntry[]) {
  if (entries.length === 0) {
    return buildSelectItems([
      {
        value: '__empty__',
        label: '(no log entries for this task)',
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

export async function showActionDetailOverlay(
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

  await showPaginatedTextOverlay(tui, {
    title: formatActionDetailTitle(block),
    body: actionDetailBody(block),
  });
}

async function showTaskLogOverlay(
  tui: TUI,
  session: SessionFile,
  taskId: string,
  taskLabel: string,
): Promise<void> {
  const entries = listLogLines(session, taskId);

  for (;;) {
    const picked = await showPickerOverlay(tui, {
      title: [
        `Actions · ${taskLabel}`,
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

export async function showLogBrowser(
  tui: TUI,
  session: SessionFile,
): Promise<void> {
  const tasks = listLogTasks(session);
  if (tasks.length === 0) {
    await showPickerOverlay(tui, {
      title: `Actions · ${session.session_id}\n(no tasks or in-flight context)`,
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
      `Actions · ${session.session_id}`,
      'Pick a task · Enter drill-down · Esc cancel',
    ].join('\n'),
    items: taskItems,
    maxVisible: Math.min(taskItems.length, 10),
  });

  if (!picked) return;

  const task = tasks.find((t) => t.taskId === picked.value);
  await showTaskLogOverlay(
    tui,
    session,
    picked.value,
    task?.label ?? picked.value,
  );
}