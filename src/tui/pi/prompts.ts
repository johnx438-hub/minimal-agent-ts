import type { PermissionChoice, PermissionRequest } from '../../permission-gate.js';
import type { WorkflowCheckpointInfo } from '../../workflow-checkpoint.js';
import { formatWorkflowCheckpoint } from '../../workflow-checkpoint.js';

import type { TUI } from '@earendil-works/pi-tui';

import { showSelectOverlay } from './select-overlay.js';

export function createPiPermissionPrompter(
  tui: TUI,
  onSessionGrant: (kind: 'shell' | 'web') => void,
): (req: PermissionRequest) => Promise<PermissionChoice> {
  return async (req) => {
    const label = req.kind === 'shell' ? 'run_shell' : 'web_fetch';
    const item = await showSelectOverlay(
      tui,
      `⚠ ${label} requested (${req.reason}) but ${req.kind} is OFF`,
      [
        { value: 'session', label: 'Session', description: 'Allow for this session' },
        { value: 'once', label: 'Once', description: 'Allow once for this run' },
        { value: 'deny', label: 'Deny', description: 'Reject this request' },
      ],
    );
    if (!item || item.value === 'deny') return 'deny';
    if (item.value === 'session') {
      onSessionGrant(req.kind);
      return 'session';
    }
    return 'once';
  };
}

export function createPiWorkflowConfirm(tui: TUI): (info: WorkflowCheckpointInfo) => Promise<boolean> {
  return async (info) => {
    const item = await showSelectOverlay(tui, formatWorkflowCheckpoint(info), [
      { value: 'yes', label: 'Run workflow', description: 'Proceed with checkpoint' },
      { value: 'no', label: 'Cancel', description: 'Return to prompt' },
    ]);
    return item?.value === 'yes';
  };
}

export function createPiFatiguePrompter(
  tui: TUI,
): (stats: { compressions: number; totalPruned: number }) => Promise<'continue' | 'handoff' | 'clear'> {
  return async (stats) => {
    const item = await showSelectOverlay(
      tui,
      `Context compression fatigue (${stats.compressions} compressions, ${stats.totalPruned} pruned)`,
      [
        { value: 'continue', label: 'Continue', description: 'Keep in this session' },
        { value: 'handoff', label: 'Handoff + new session', description: 'Write handoff and start fresh' },
        { value: 'clear', label: 'Clear context', description: 'Truncate in-flight messages' },
      ],
    );
    const v = item?.value;
    if (v === 'handoff' || v === 'clear') return v;
    return 'continue';
  };
}

export async function runPiFirstRunConfirm(
  tui: TUI,
  getShell: () => boolean,
  getWeb: () => boolean,
  toggleShell: () => void,
  toggleWeb: () => void,
): Promise<void> {
  for (;;) {
    const shell = getShell();
    const web = getWeb();
    const item = await showSelectOverlay(
      tui,
      `First run — confirm tools\n  shell [${shell ? 'on' : 'off'}]  web [${web ? 'on' : 'off'}]`,
      [
        { value: 'confirm', label: 'Continue', description: 'Save and start' },
        { value: 'shell', label: 'Toggle shell', description: `Currently ${shell ? 'on' : 'off'}` },
        { value: 'web', label: 'Toggle web', description: `Currently ${web ? 'on' : 'off'}` },
      ],
      { cancelable: false },
    );
    if (!item || item.value === 'confirm') return;
    if (item.value === 'shell') toggleShell();
    if (item.value === 'web') toggleWeb();
  }
}