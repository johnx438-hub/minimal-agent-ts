/**
 * Workspace root, session store layout (SPEC_SESSION_WORKSPACE).
 * - project_local (default): `<cwd>/.sessions` (legacy)
 * - agent_home: `$AGENT_HOME/sessions/by-project/<project_id>/`
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve, sep } from 'node:path';

export type SessionStoreMode = 'project_local' | 'agent_home';

export type WorkspaceGrantMode = 'read_only' | 'read_write';
export type WorkspaceGrantScope = 'once' | 'session' | 'sticky';

export interface WorkspaceGrant {
  root: string;
  mode: WorkspaceGrantMode;
  scope: WorkspaceGrantScope;
  shell?: boolean;
  web?: boolean;
  granted_at: number;
  label?: string;
}

export interface SessionWorkspaceState {
  project_id: string;
  primary_root: string;
  active_cwd: string;
  workspace_grants: WorkspaceGrant[];
  inherit_capabilities_on_cwd_switch?: boolean;
}

export type CwdCapabilityPolicy = 'strict' | 'inherit_session' | 'inherit_grant_only';

/** Active tool / project cwd (sandbox default root). */
let activeCwd = resolve(process.cwd());
/** Project bucket key source; fixed for a session when agent_home. */
let primaryRoot = activeCwd;
let projectId = projectIdFromRoot(primaryRoot);
let sessionStoreMode: SessionStoreMode = 'project_local';
let agentHomePath = defaultAgentHome();
let grants: WorkspaceGrant[] = [defaultPrimaryGrant(primaryRoot)];
let capabilityPolicy: CwdCapabilityPolicy = 'strict';

export function defaultAgentHome(): string {
  const env =
    process.env.MINIMAL_AGENT_HOME?.trim() ||
    process.env.AGENT_HOME?.trim();
  if (env) {
    return resolve(env.startsWith('~/') ? resolve(homedir(), env.slice(2)) : env);
  }
  return resolve(homedir(), '.minimal-agent');
}

export function projectIdFromRoot(root: string): string {
  const normalized = resolve(root);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function defaultPrimaryGrant(root: string): WorkspaceGrant {
  return {
    root: resolve(root),
    mode: 'read_write',
    scope: 'session',
    granted_at: Date.now(),
    label: 'primary',
  };
}

function isUnderRoot(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r + sep);
}

/** Active project root — tools default relative paths here. */
export function getWorkspaceRoot(): string {
  return activeCwd;
}

export function getPrimaryRoot(): string {
  return primaryRoot;
}

export function getProjectId(): string {
  return projectId;
}

export function getSessionStoreMode(): SessionStoreMode {
  return sessionStoreMode;
}

export function getAgentHome(): string {
  return agentHomePath;
}

export function getWorkspaceGrants(): WorkspaceGrant[] {
  return grants.map((g) => ({ ...g }));
}

export function getCwdCapabilityPolicy(): CwdCapabilityPolicy {
  return capabilityPolicy;
}

export function setCwdCapabilityPolicy(policy: CwdCapabilityPolicy): void {
  capabilityPolicy = policy;
}

/**
 * Configure store mode / agent home (from agent.json or tests).
 * Does not change active_cwd unless `cwd` is provided.
 */
export function configureSessionStore(opts: {
  mode?: SessionStoreMode;
  agentHome?: string;
  cwd?: string;
  capabilityPolicy?: CwdCapabilityPolicy;
}): void {
  if (opts.agentHome) {
    agentHomePath = resolve(opts.agentHome);
  }
  if (opts.mode === 'project_local' || opts.mode === 'agent_home') {
    sessionStoreMode = opts.mode;
  }
  if (opts.capabilityPolicy) {
    capabilityPolicy = opts.capabilityPolicy;
  }
  if (opts.cwd) {
    // Explicit cwd in configure = (re)bind project primary + active
    if (sessionStoreMode === 'agent_home') {
      setPrimaryRoot(opts.cwd);
    } else {
      setWorkspaceRoot(opts.cwd);
    }
  } else {
    ensureSessionsDir();
  }
}

/**
 * Reset workspace module (tests).
 * @param cwd active (and primary) root
 */
export function resetWorkspaceForTests(cwd?: string): void {
  const root = resolve(cwd ?? process.cwd());
  activeCwd = root;
  primaryRoot = root;
  projectId = projectIdFromRoot(root);
  sessionStoreMode = 'project_local';
  agentHomePath = defaultAgentHome();
  grants = [defaultPrimaryGrant(root)];
  capabilityPolicy = 'strict';
  ensureSessionsDir();
}

/**
 * Set active tool cwd. In project_local mode this also moves the session store
 * root (legacy). In agent_home mode, session bucket stays on primaryRoot/projectId.
 */
export function setWorkspaceRoot(cwd: string): void {
  activeCwd = resolve(cwd);
  if (sessionStoreMode === 'project_local') {
    primaryRoot = activeCwd;
    projectId = projectIdFromRoot(primaryRoot);
    grants = [defaultPrimaryGrant(primaryRoot)];
  } else {
    // agent_home: keep primary/projectId; ensure primary still granted
    ensurePrimaryGrant();
  }
  ensureSessionsDir();
}

/** Rebind project bucket (new session or explicit rebind). */
export function setPrimaryRoot(root: string): void {
  primaryRoot = resolve(root);
  projectId = projectIdFromRoot(primaryRoot);
  activeCwd = primaryRoot;
  grants = [defaultPrimaryGrant(primaryRoot)];
  ensureSessionsDir();
}

function ensurePrimaryGrant(): void {
  const p = resolve(primaryRoot);
  if (!grants.some((g) => resolve(g.root) === p)) {
    grants = [defaultPrimaryGrant(p), ...grants];
  }
}

/** Replace grants (e.g. restore from SessionFile). */
export function setWorkspaceGrants(next: WorkspaceGrant[]): void {
  grants = next.map((g) => ({
    ...g,
    root: resolve(g.root),
  }));
  ensurePrimaryGrant();
}

export function addWorkspaceGrant(grant: WorkspaceGrant): WorkspaceGrant {
  const normalized: WorkspaceGrant = {
    ...grant,
    root: resolve(grant.root),
    granted_at: grant.granted_at || Date.now(),
  };
  const without = grants.filter((g) => resolve(g.root) !== normalized.root);
  grants = [...without, normalized];
  return normalized;
}

export function revokeWorkspaceGrant(root: string): boolean {
  const r = resolve(root);
  const before = grants.length;
  grants = grants.filter((g) => resolve(g.root) !== r);
  // Never drop primary silently in agent_home
  if (sessionStoreMode === 'agent_home') {
    ensurePrimaryGrant();
  } else if (grants.length === 0) {
    grants = [defaultPrimaryGrant(activeCwd)];
  }
  return grants.length < before;
}

export function findGrantForPath(targetAbs: string): WorkspaceGrant | undefined {
  const t = resolve(targetAbs);
  // Prefer longest matching root
  const matches = grants
    .filter((g) => isUnderRoot(g.root, t))
    .sort((a, b) => b.root.length - a.root.length);
  return matches[0];
}

export function isPathReadableByGrants(targetAbs: string): boolean {
  return Boolean(findGrantForPath(targetAbs));
}

export function isPathWritableByGrants(targetAbs: string): boolean {
  const g = findGrantForPath(targetAbs);
  return Boolean(g && g.mode === 'read_write');
}

export function buildSessionWorkspaceState(
  inherit?: boolean,
): SessionWorkspaceState {
  return {
    project_id: projectId,
    primary_root: primaryRoot,
    active_cwd: activeCwd,
    workspace_grants: getWorkspaceGrants(),
    inherit_capabilities_on_cwd_switch: inherit ?? false,
  };
}

/** Apply workspace block from a resumed session onto the process. */
export function applySessionWorkspaceState(ws: SessionWorkspaceState): void {
  projectId = ws.project_id || projectIdFromRoot(ws.primary_root);
  primaryRoot = resolve(ws.primary_root);
  activeCwd = resolve(ws.active_cwd || ws.primary_root);
  setWorkspaceGrants(ws.workspace_grants?.length ? ws.workspace_grants : [defaultPrimaryGrant(primaryRoot)]);
  ensureSessionsDir();
}

export function sessionsDir(): string {
  if (sessionStoreMode === 'agent_home') {
    return resolve(
      agentHomePath,
      'sessions',
      'by-project',
      projectId,
    );
  }
  return resolve(activeCwd, '.sessions');
}

export function ensureSessionsDir(): void {
  const dir = sessionsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (sessionStoreMode === 'agent_home' && !existsSync(agentHomePath)) {
    mkdirSync(agentHomePath, { recursive: true });
  }
}

export function sessionPath(sessionId: string): string {
  return resolve(sessionsDir(), `${sessionId}.json`);
}

export function actionsDir(): string {
  return resolve(sessionsDir(), 'actions');
}

export function spawnActionsDir(parentSessionId: string): string {
  return resolve(actionsDir(), 'spawn', parentSessionId);
}

export function spawnRunsDir(parentSessionId: string): string {
  return resolve(sessionsDir(), 'spawn', parentSessionId);
}

export function spawnRunsPath(parentSessionId: string): string {
  return resolve(spawnRunsDir(parentSessionId), 'runs.jsonl');
}

export function agentMemoryDir(): string {
  return resolve(sessionsDir(), 'agent_memory');
}

export function handoffPath(sessionId: string): string {
  return resolve(sessionsDir(), `handoff_${sessionId}.md`);
}

export function transcriptPath(sessionId: string): string {
  return resolve(sessionsDir(), `transcript_${sessionId}.jsonl`);
}

export function formatWorkspaceGrantLine(g: WorkspaceGrant): string {
  const flags = [
    g.mode,
    g.scope,
    g.shell ? 'shell' : null,
    g.web ? 'web' : null,
    g.label,
  ]
    .filter(Boolean)
    .join(' ');
  return `${g.root}  (${flags})`;
}

export function projectDisplayName(root: string = primaryRoot): string {
  return basename(resolve(root)) || root;
}

export function resolveMaybeRelative(fromCwd: string, input: string): string {
  return isAbsolute(input) ? resolve(input) : resolve(fromCwd, input);
}
