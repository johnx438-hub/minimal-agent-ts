import type {
  CapabilityKind,
  PermissionChoice,
  PermissionRequest,
} from '../../permission-gate.js';
import type { WorkflowCheckpointInfo } from '../../workflow-checkpoint.js';
import { formatWorkflowCheckpoint } from '../../workflow-checkpoint.js';

import type { TUI } from '@earendil-works/pi-tui';

import { showSelectOverlay } from './select-overlay.js';

function permissionOverlayTitle(req: PermissionRequest): string {
  if (req.kind === 'path_escape') {
    return `⚠ path outside cwd\n${req.reason}`;
  }
  const label = req.kind === 'shell' ? 'run_shell' : 'web_fetch';
  return `⚠ ${label} requested (${req.reason}) but ${req.kind} is OFF`;
}

export function createPiPermissionPrompter(
  tui: TUI,
  onSessionGrant: (kind: CapabilityKind) => void,
): (req: PermissionRequest) => Promise<PermissionChoice> {
  return async (req) => {
    const item = await showSelectOverlay(
      tui,
      permissionOverlayTitle(req),
      [
        { value: 'session', label: 'Session', description: 'Allow for this session' },
        { value: 'once', label: 'Once', description: 'Allow once for this run' },
        { value: 'deny', label: 'Deny', description: 'Reject this request' },
      ],
      { abortSignal: req.abortSignal },
    );
    if (!item || item.value === 'deny') return 'deny';
    if (item.value === 'session') {
      onSessionGrant(req.kind);
      return 'session';
    }
    return 'once';
  };
}

export function createPiCwdChangeConfirm(
  tui: TUI,
): (fromCwd: string, toPath: string, signal?: AbortSignal) => Promise<boolean> {
  return async (fromCwd, toPath, signal) => {
    if (signal?.aborted) return false;
    const item = await showSelectOverlay(
      tui,
      `⚠ Change cwd outside current tree?\n  from: ${fromCwd}\n  to:   ${toPath}`,
      [
        { value: 'yes', label: 'Change cwd', description: 'Allow for this session' },
        { value: 'no', label: 'Cancel', description: 'Keep current cwd' },
      ],
      { abortSignal: signal },
    );
    if (signal?.aborted) return false;
    return item?.value === 'yes';
  };
}

export function createPiWorkflowConfirm(
  tui: TUI,
): (info: WorkflowCheckpointInfo, signal?: AbortSignal) => Promise<boolean> {
  return async (info, signal) => {
    if (signal?.aborted) return false;
    const item = await showSelectOverlay(tui, formatWorkflowCheckpoint(info), [
      { value: 'yes', label: 'Run workflow', description: 'Proceed with checkpoint' },
      { value: 'no', label: 'Cancel', description: 'Return to prompt' },
    ], { abortSignal: signal });
    if (signal?.aborted) return false;
    return item?.value === 'yes';
  };
}

export function createPiFatiguePrompter(
  tui: TUI,
): (stats: { compressions: number; totalPruned: number }) => Promise<'continue' | 'brief' | 'clear'> {
  return async (stats) => {
    const item = await showSelectOverlay(
      tui,
      `Context compression fatigue (${stats.compressions} compressions, ${stats.totalPruned} pruned)`,
      [
        { value: 'continue', label: 'Continue', description: 'Keep in this session' },
        { value: 'brief', label: 'Brief + new session', description: 'Write session brief and start fresh' },
        { value: 'clear', label: 'Clear context', description: 'Truncate in-flight messages' },
      ],
    );
    const v = item?.value;
    if (v === 'brief' || v === 'clear') return v;
    return 'continue';
  };
}

/**
 * Confirm abort of the current agent run (Esc when no other overlay).
 * Esc on this panel cancels (keep running); Enter on Stop aborts.
 */
export function createPiAbortConfirm(tui: TUI): () => Promise<boolean> {
  return async () => {
    const item = await showSelectOverlay(
      tui,
      'Stop current run?\n  Background jobs keep running unless you cancel them separately.',
      [
        {
          value: 'stop',
          label: 'Stop run',
          description: 'Abort main agent (session is saved)',
        },
        {
          value: 'keep',
          label: 'Keep running',
          description: 'Dismiss and continue (Esc)',
        },
      ],
    );
    return item?.value === 'stop';
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