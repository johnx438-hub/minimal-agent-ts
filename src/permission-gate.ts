import type { AgentConfig } from './types.js';

export type CapabilityKind = 'shell' | 'web' | 'path_escape';

export type PermissionChoice = 'once' | 'session' | 'deny';

export interface PermissionRequest {
  kind: CapabilityKind;
  reason: string;
  abortSignal?: AbortSignal;
}

export type PermissionPromptFn = (req: PermissionRequest) => Promise<PermissionChoice>;

export type PermissionLifecycleEvent =
  | { type: 'permission_prompt_start'; kind: CapabilityKind; reason: string }
  | {
      type: 'permission_prompt_end';
      kind: CapabilityKind;
      approved: boolean;
      reason: 'approved' | 'denied' | 'aborted';
    };

/**
 * JIT capability gate for shell/web. Mutates config.allowShell/allowWeb when user approves.
 */
export class PermissionGate {
  private sessionGrants = new Set<CapabilityKind>();
  private alwaysGrants = new Set<CapabilityKind>();
  private prompter?: PermissionPromptFn;
  private lifecycle?: (event: PermissionLifecycleEvent) => void;

  setPrompter(fn: PermissionPromptFn | undefined): void {
    this.prompter = fn;
  }

  setLifecycle(fn: ((event: PermissionLifecycleEvent) => void) | undefined): void {
    this.lifecycle = fn;
  }

  setAlwaysGrants(grants: { shell?: boolean; web?: boolean }): void {
    this.alwaysGrants.clear();
    if (grants.shell) this.alwaysGrants.add('shell');
    if (grants.web) this.alwaysGrants.add('web');
  }

  hasAlwaysGrant(kind: CapabilityKind): boolean {
    return this.alwaysGrants.has(kind);
  }

  grantSession(kind: CapabilityKind): void {
    this.sessionGrants.add(kind);
  }

  hasSessionGrant(kind: CapabilityKind): boolean {
    return this.sessionGrants.has(kind);
  }

  async ensureShell(config: AgentConfig, reason: string): Promise<boolean> {
    return this.ensure('shell', config, reason);
  }

  async ensureWeb(config: AgentConfig, reason: string): Promise<boolean> {
    return this.ensure('web', config, reason);
  }

  /** JIT approval for read-only access outside `config.cwd` (write/edit stay hard-rejected). */
  async ensurePathEscape(config: AgentConfig, reason: string): Promise<boolean> {
    return this.ensure('path_escape', config, reason);
  }

  private async ensure(
    kind: CapabilityKind,
    config: AgentConfig,
    reason: string,
  ): Promise<boolean> {
    if (kind === 'path_escape') {
      // path_escape is always JIT-gated; no persistent allow* flag on config.
    } else {
      const enabled = kind === 'shell' ? config.allowShell : config.allowWeb;
      if (enabled) return true;
    }

    if (this.alwaysGrants.has(kind)) {
      if (kind === 'shell') config.allowShell = true;
      else if (kind === 'web') config.allowWeb = true;
      return true;
    }

    if (this.sessionGrants.has(kind)) {
      if (kind === 'shell') config.allowShell = true;
      else if (kind === 'web') config.allowWeb = true;
      return true;
    }

    if (config.abortSignal?.aborted) return false;

    if (!this.prompter) return false;

    this.lifecycle?.({ type: 'permission_prompt_start', kind, reason });
    const choice = await this.promptWithAbort(config.abortSignal, { kind, reason });
    const approved = choice !== 'deny' && !config.abortSignal?.aborted;
    const endReason = config.abortSignal?.aborted
      ? 'aborted'
      : choice === 'deny'
        ? 'denied'
        : 'approved';
    this.lifecycle?.({
      type: 'permission_prompt_end',
      kind,
      approved,
      reason: endReason,
    });

    if (!approved) return false;

    if (choice === 'session') {
      this.sessionGrants.add(kind);
    }

    if (kind === 'shell') config.allowShell = true;
    else if (kind === 'web') config.allowWeb = true;
    return true;
  }

  private promptWithAbort(
    signal: AbortSignal | undefined,
    req: PermissionRequest,
  ): Promise<PermissionChoice> {
    if (!this.prompter) return Promise.resolve('deny');
    if (signal?.aborted) return Promise.resolve('deny');

    const request: PermissionRequest = { ...req, abortSignal: signal };

    return new Promise((resolve) => {
      let settled = false;
      const finish = (choice: PermissionChoice): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(choice);
      };

      const onAbort = (): void => finish('deny');
      signal?.addEventListener('abort', onAbort, { once: true });

      void this.prompter!(request).then((choice) => finish(choice));
    });
  }
}

export function attachPermissionGate(config: AgentConfig, gate: PermissionGate | undefined): void {
  config.permissionGate = gate;
}

/** Shell/web exposed to the model when allow* is on or an always grant is active. */
export function isCapabilityEnabled(
  config: AgentConfig,
  kind: CapabilityKind,
): boolean {
  const allowed = kind === 'shell' ? config.allowShell : config.allowWeb;
  if (allowed) return true;
  return config.permissionGate?.hasAlwaysGrant(kind) ?? false;
}