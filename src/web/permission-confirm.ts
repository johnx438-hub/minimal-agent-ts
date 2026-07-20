/**
 * Web UI JIT permission gate — focused on path_escape (read outside cwd).
 * Shell/web stay Settings-only: prompter auto-denies those kinds.
 */

import type {
  PermissionChoice,
  PermissionPromptFn,
  PermissionRequest,
} from '../permission-gate.js';
import type { WsHub } from './ws-hub.js';

export interface WebPermissionConfirmPending {
  type: 'permission_confirm';
  status: 'pending';
  kind: 'path_escape' | 'shell' | 'web';
  reason: string;
}

export interface WebPermissionConfirmResolved {
  type: 'permission_confirm';
  status: 'approved' | 'denied' | 'aborted';
  kind: 'path_escape' | 'shell' | 'web';
  choice?: PermissionChoice;
}

export type WebPermissionConfirmFrame =
  | WebPermissionConfirmPending
  | WebPermissionConfirmResolved;

export interface WebPermissionConfirmController {
  prompter: PermissionPromptFn;
  respond: (choice: PermissionChoice) => boolean;
  getPending: () => WebPermissionConfirmPending | null;
  dispose: () => void;
}

function toPendingFrame(req: PermissionRequest): WebPermissionConfirmPending {
  return {
    type: 'permission_confirm',
    status: 'pending',
    kind: req.kind,
    reason: req.reason,
  };
}

/**
 * Single-slot confirm for path_escape. Concurrent prompts deny the previous waiter.
 * Shell/web requests resolve to deny without broadcasting (use Settings).
 */
export function createWebPermissionConfirm(
  hub: WsHub,
): WebPermissionConfirmController {
  let pending: {
    req: PermissionRequest;
    resolve: (choice: PermissionChoice) => void;
    onAbort: () => void;
    signal?: AbortSignal;
  } | null = null;

  function clearPending(
    status: 'approved' | 'denied' | 'aborted',
    choice: PermissionChoice,
  ): void {
    if (!pending) return;
    const { req, resolve, onAbort, signal } = pending;
    pending = null;
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
    hub.broadcast({
      type: 'permission_confirm',
      status,
      kind: req.kind,
      choice,
    } satisfies WebPermissionConfirmResolved);
    resolve(choice);
  }

  const prompter: PermissionPromptFn = async (req) => {
    // Shell / web: Settings hot-toggle only — no browser modal.
    if (req.kind === 'shell' || req.kind === 'web') {
      return 'deny';
    }

    if (req.abortSignal?.aborted) return 'deny';

    if (pending) {
      clearPending('denied', 'deny');
    }

    return new Promise<PermissionChoice>((resolve) => {
      const onAbort = () => {
        if (!pending) return;
        clearPending('aborted', 'deny');
      };

      pending = { req, resolve, onAbort, signal: req.abortSignal };
      req.abortSignal?.addEventListener('abort', onAbort, { once: true });
      hub.broadcast(toPendingFrame(req));
    });
  };

  return {
    prompter,
    respond(choice: PermissionChoice): boolean {
      if (!pending) return false;
      if (choice === 'deny') {
        clearPending('denied', 'deny');
        return true;
      }
      clearPending('approved', choice);
      return true;
    },
    getPending(): WebPermissionConfirmPending | null {
      return pending ? toPendingFrame(pending.req) : null;
    },
    dispose(): void {
      if (pending) clearPending('aborted', 'deny');
    },
  };
}
