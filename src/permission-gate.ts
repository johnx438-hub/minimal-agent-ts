import type { AgentConfig } from './types.js';

export type CapabilityKind = 'shell' | 'web';

export type PermissionChoice = 'once' | 'session' | 'deny';

export interface PermissionRequest {
  kind: CapabilityKind;
  reason: string;
}

export type PermissionPromptFn = (req: PermissionRequest) => Promise<PermissionChoice>;

/**
 * JIT capability gate for shell/web. Mutates config.allowShell/allowWeb when user approves.
 */
export class PermissionGate {
  private sessionGrants = new Set<CapabilityKind>();
  private prompter?: PermissionPromptFn;

  setPrompter(fn: PermissionPromptFn | undefined): void {
    this.prompter = fn;
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

  private async ensure(
    kind: CapabilityKind,
    config: AgentConfig,
    reason: string,
  ): Promise<boolean> {
    const enabled = kind === 'shell' ? config.allowShell : config.allowWeb;
    if (enabled) return true;

    if (this.sessionGrants.has(kind)) {
      if (kind === 'shell') config.allowShell = true;
      else config.allowWeb = true;
      return true;
    }

    if (!this.prompter) return false;

    const choice = await this.prompter({ kind, reason });
    if (choice === 'deny') return false;

    if (choice === 'session') {
      this.sessionGrants.add(kind);
    }

    if (kind === 'shell') config.allowShell = true;
    else config.allowWeb = true;
    return true;
  }
}

export function attachPermissionGate(config: AgentConfig, gate: PermissionGate | undefined): void {
  config.permissionGate = gate;
}