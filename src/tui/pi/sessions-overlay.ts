/**
 * /sessions browser: dense list (summary right column) + note edit + detail.
 */

import type { SelectItem, TUI } from '@earendil-works/pi-tui';

import type { AgentRuntime } from '../../runner.js';
import {
  formatSessionPickerDescription,
  formatSessionPickerLabel,
  getSessionNoteMaxChars,
} from '../../session.js';
import type { SessionMeta } from '../../types.js';
import { buildSelectItems, showPickerOverlay } from './picker.js';
import { showInputOverlay } from './input-overlay.js';
import { showSessionDetailOverlay } from './session-detail.js';

const LIST_LIMIT = 20;

export type SessionBrowseResult =
  | { kind: 'resume'; sessionId: string }
  | { kind: 'cancel' };

function buildSessionItems(
  sessions: SessionMeta[],
  currentId: string,
): SelectItem[] {
  return buildSelectItems(
    sessions.map((s) => ({
      value: s.session_id,
      label: formatSessionPickerLabel(s, { currentId }),
      description: formatSessionPickerDescription(s),
    })),
  );
}

/**
 * Interactive session list. Re-opens after note edits so rows stay fresh.
 */
export async function showSessionsBrowser(
  tui: TUI,
  runtime: AgentRuntime,
  opts?: {
    say?: (msg: string, dim?: boolean) => void;
  },
): Promise<SessionBrowseResult> {
  const say = opts?.say;

  for (;;) {
    const sessions = runtime.listSessions().slice(0, LIST_LIMIT);
    if (sessions.length === 0) {
      say?.('(no sessions)');
      return { kind: 'cancel' };
    }

    const currentId = runtime.sessionLabel();
    const items = buildSessionItems(sessions, currentId);
    const title = [
      'Sessions — Enter resume · i detail · n note · Esc cancel',
      'Left: time · note|id   Right: last task summary · files · Nt',
    ].join('\n');

    const picked = await showPickerOverlay(tui, {
      title,
      items,
      maxVisible: Math.min(items.length, 10),
      onInfo: async (item, finish) => {
        const overview = runtime.getSessionOverview(item.value);
        if (!overview) {
          say?.(`Session not found: ${item.value}`);
          return;
        }
        const fullSession = runtime.resolveHistorySession(item.value);
        const action = await showSessionDetailOverlay(tui, overview, fullSession, {
          saveNote: (id, n) => runtime.setSessionNote(id, n),
        });
        if (action === 'resume') finish(item);
        if (action === 'note_saved') {
          finish({ value: `__refresh__:${item.value}`, label: item.label });
        }
      },
      onKey: async (key, ctx) => {
        if (key !== 'n') return false;
        const item = ctx.getSelectedItem();
        if (!item || item.value.startsWith('__')) return true;

        const meta = sessions.find((s) => s.session_id === item.value);
        const max = getSessionNoteMaxChars();
        const next = await showInputOverlay(
          tui,
          [
            `Note for ${item.value}`,
            `Enter save · Esc cancel · empty clears · max ${max} chars`,
          ].join('\n'),
          { initial: meta?.note ?? '' },
        );
        if (next === null) return true;

        if (!runtime.setSessionNote(item.value, next)) {
          say?.(`Session not found: ${item.value}`);
          return true;
        }
        ctx.finish({ value: `__refresh__:${item.value}`, label: item.label });
        return true;
      },
    });

    if (!picked) return { kind: 'cancel' };
    if (picked.value.startsWith('__refresh__:')) continue;
    return { kind: 'resume', sessionId: picked.value };
  }
}
