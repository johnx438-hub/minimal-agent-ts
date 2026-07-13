/**
 * /sessions browser: dense list (summary right column) + note / delete + detail.
 */

import type { SelectItem, TUI } from '@earendil-works/pi-tui';

import type { AgentRuntime } from '../../runner.js';
import {
  formatSessionPickerDescription,
  formatSessionPickerLabel,
  getSessionNoteMaxChars,
} from '../../session.js';
import { formatSessionDeleteSummary } from '../../session-delete.js';
import type { SessionMeta } from '../../types.js';
import { buildSelectItems, showPickerOverlay } from './picker.js';
import { showInputOverlay } from './input-overlay.js';
import { showSelectOverlay } from './select-overlay.js';
import { showSessionDetailOverlay } from './session-detail.js';

const LIST_LIMIT = 20;

export type SessionBrowseResult =
  | { kind: 'resume'; sessionId: string }
  | { kind: 'deleted'; sessionId: string }
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

async function confirmDeleteSession(
  tui: TUI,
  runtime: AgentRuntime,
  sessionId: string,
): Promise<boolean> {
  const art = runtime.collectSessionArtifacts(sessionId);
  const item = await showSelectOverlay(
    tui,
    formatSessionDeleteSummary(art),
    [
      {
        value: 'delete',
        label: 'Delete permanently',
        description: 'Session + actions + spawn + jobs',
      },
      {
        value: 'cancel',
        label: 'Cancel',
        description: 'Keep session (Esc)',
      },
    ],
  );
  return item?.value === 'delete';
}

/**
 * Interactive session list. Re-opens after note/delete so rows stay fresh.
 */
export async function showSessionsBrowser(
  tui: TUI,
  runtime: AgentRuntime,
  opts?: {
    say?: (msg: string, dim?: boolean) => void;
    printStatus?: () => void;
  },
): Promise<SessionBrowseResult> {
  const say = opts?.say;
  let lastDeleted: string | undefined;

  for (;;) {
    const sessions = runtime.listSessions().slice(0, LIST_LIMIT);
    if (sessions.length === 0) {
      say?.(lastDeleted ? `(deleted ${lastDeleted}; no sessions left)` : '(no sessions)');
      return lastDeleted
        ? { kind: 'deleted', sessionId: lastDeleted }
        : { kind: 'cancel' };
    }

    const currentId = runtime.sessionLabel();
    const items = buildSessionItems(sessions, currentId);
    const title = [
      'Sessions — Enter resume · i detail · n note · d delete · Esc cancel',
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
        const item = ctx.getSelectedItem();
        if (!item || item.value.startsWith('__')) {
          return key === 'n' || key === 'd';
        }

        if (key === 'n') {
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
        }

        if (key === 'd') {
          if (runtime.isRunning() && runtime.sessionLabel() === item.value) {
            say?.('Cannot delete: session is running — /stop first');
            return true;
          }
          const ok = await confirmDeleteSession(tui, runtime, item.value);
          if (!ok) return true;

          const result = runtime.deleteSession(item.value);
          if (!result.ok) {
            say?.(`Delete failed: ${result.reason ?? 'unknown'}`);
            return true;
          }
          const d = result.deleted;
          say?.(
            `Deleted ${item.value}` +
              (d
                ? ` (actions=${d.flat_actions}, jobs=${d.jobs}, spawn=${d.spawn_actions_dir ? 'y' : 'n'})`
                : ''),
          );
          opts?.printStatus?.();
          lastDeleted = item.value;
          ctx.finish({ value: `__refresh__:deleted`, label: 'refresh' });
          return true;
        }

        return false;
      },
    });

    if (!picked) {
      return lastDeleted
        ? { kind: 'deleted', sessionId: lastDeleted }
        : { kind: 'cancel' };
    }
    if (picked.value.startsWith('__refresh__:')) continue;
    return { kind: 'resume', sessionId: picked.value };
  }
}
