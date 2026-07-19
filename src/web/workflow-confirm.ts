/**
 * Web UI workflow entry confirmation (TUI overlay parity).
 * Strict gate: no always-remember; client must POST /v1/workflow/confirm.
 */

import type { WorkflowConfirmFn } from '../runner.js';
import type { WorkflowCheckpointInfo } from '../workflow-checkpoint.js';
import { formatWorkflowCheckpoint } from '../workflow-checkpoint.js';
import type { WsHub } from './ws-hub.js';

export interface WebWorkflowConfirmRole {
  name: string;
  tools: string[];
  needs_shell: boolean;
  needs_web: boolean;
}

/** Control frame + REST snapshot for the pending gate. */
export interface WebWorkflowConfirmPending {
  type: 'workflow_confirm';
  status: 'pending';
  workflow: string;
  path: string;
  needs_shell: boolean;
  needs_web: boolean;
  roles: WebWorkflowConfirmRole[];
  /** Human-readable block (same text as TUI overlay). */
  summary: string;
}

export interface WebWorkflowConfirmResolved {
  type: 'workflow_confirm';
  status: 'approved' | 'denied' | 'aborted';
  workflow: string;
}

export type WebWorkflowConfirmFrame =
  | WebWorkflowConfirmPending
  | WebWorkflowConfirmResolved;

function toPendingFrame(info: WorkflowCheckpointInfo): WebWorkflowConfirmPending {
  return {
    type: 'workflow_confirm',
    status: 'pending',
    workflow: info.name,
    path: info.path,
    needs_shell: info.needsShell,
    needs_web: info.needsWeb,
    roles: info.roles.map((r) => ({
      name: r.name,
      tools: r.tools,
      needs_shell: r.needsShell,
      needs_web: r.needsWeb,
    })),
    summary: formatWorkflowCheckpoint(info),
  };
}

export interface WebWorkflowConfirmController {
  confirmFn: WorkflowConfirmFn;
  /** Resolve pending gate. Returns false if nothing pending. */
  respond: (approved: boolean) => boolean;
  getPending: () => WebWorkflowConfirmPending | null;
  dispose: () => void;
}

/**
 * Create a single-slot confirm gate bound to the WS hub.
 * Concurrent workflow entries are rejected (previous denied).
 */
export function createWebWorkflowConfirm(hub: WsHub): WebWorkflowConfirmController {
  let pending: {
    info: WorkflowCheckpointInfo;
    resolve: (approved: boolean) => void;
    onAbort: () => void;
    signal?: AbortSignal;
  } | null = null;

  function clearPending(result: 'approved' | 'denied' | 'aborted'): void {
    if (!pending) return;
    const { info, resolve, onAbort, signal } = pending;
    pending = null;
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
    hub.broadcast({
      type: 'workflow_confirm',
      status: result,
      workflow: info.name,
    } satisfies WebWorkflowConfirmResolved);
    resolve(result === 'approved');
  }

  const confirmFn: WorkflowConfirmFn = (info, signal) => {
    if (signal?.aborted) return Promise.resolve(false);

    // One confirm at a time — deny the previous waiter
    if (pending) {
      clearPending('denied');
    }

    return new Promise<boolean>((resolve) => {
      const onAbort = () => {
        if (!pending) return;
        clearPending('aborted');
      };

      pending = { info, resolve, onAbort, signal };
      signal?.addEventListener('abort', onAbort, { once: true });
      hub.broadcast(toPendingFrame(info));
    });
  };

  return {
    confirmFn,
    respond(approved: boolean): boolean {
      if (!pending) return false;
      clearPending(approved ? 'approved' : 'denied');
      return true;
    },
    getPending(): WebWorkflowConfirmPending | null {
      return pending ? toPendingFrame(pending.info) : null;
    },
    dispose(): void {
      if (pending) clearPending('aborted');
    },
  };
}
