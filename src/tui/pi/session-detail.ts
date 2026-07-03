import type { TUI } from '@earendil-works/pi-tui';

import type { SessionFile, SessionOverview } from '../../types.js';
import { showHistoryBrowser } from './history-overlay.js';
import { showPickerOverlay } from './picker.js';

function clip(text: string, max = 64): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function formatFiles(files: string[]): string {
  if (files.length === 0) return '';
  const joined = files.slice(0, 4).join(', ');
  const more = files.length > 4 ? ` +${files.length - 4}` : '';
  return `files: ${joined}${more}`;
}

export type SessionDetailAction = 'back' | 'resume';

export async function showSessionDetailOverlay(
  tui: TUI,
  overview: SessionOverview,
  session?: SessionFile | null,
): Promise<SessionDetailAction> {
  const active = new Date(overview.updated_at ?? overview.created_at)
    .toISOString()
    .slice(0, 16);
  const inFlight = overview.has_in_flight
    ? overview.in_flight_preview
    : '(no in-flight task)';

  const title = [
    `Session ${overview.session_id}`,
    `active=${active}  tasks=${overview.task_count}`,
    `In-flight: ${clip(inFlight, 56)}`,
    'Enter resume · h history · Esc back',
  ].join('\n');

  const taskItems = overview.tasks.map((t) => {
    const files = formatFiles(t.files_touched);
    const desc = [clip(t.user_intent, 56), files].filter(Boolean).join(' · ');
    return {
      value: t.task_id,
      label: `${t.task_id}  [${t.turn_range[0]}–${t.turn_range[1]}]`,
      description: desc || '(no intent)',
    };
  });

  if (taskItems.length === 0) {
    taskItems.push({
      value: '__none__',
      label: '(no completed tasks)',
      description: 'Only in-flight context, if any',
    });
  }

  const picked = await showPickerOverlay(tui, {
    title,
    items: taskItems,
    maxVisible: Math.min(taskItems.length, 8),
    onKey: async (key) => {
      if (key !== 'h' || !session) return false;
      await showHistoryBrowser(tui, session);
      return true;
    },
  });

  if (picked) return 'resume';
  return 'back';
}