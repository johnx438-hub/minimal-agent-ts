import { existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';

import { loadAgentPluginConfig } from './plugins/config-loader.js';
import { discoverSkills } from './plugins/skills.js';
import { runAgent, type AgentResult } from './agent.js';
import { previewPolicyFromPointerize } from './action-preview.js';
import {
  emitJsonEvent,
  formatCompressionSummary,
  formatLlmFallbackSummary,
  formatLlmRetrySummary,
  formatToolPlanSummary,
  isAbortError,
  type AgentStepEvent,
  type RuntimeEvent,
} from './events.js';
import { parseLoopGuardMode, stripLoopGuardInjections } from './loop-guard.js';
import {
  classifyAgentStopReason,
  formatWorkflowReturnSummary,
  mergeWorkflowResultIntoSessionMessages,
  parseAgentStopReason,
} from './workflow/handback.js';
import {
  ensureToolRegistry,
  reinitializeToolRegistry,
  toolRegistry,
} from './tools/registry.js';
import { PermissionGate } from './permission-gate.js';
import {
  buildSessionOverview,
  createSession,
  getLatestSession,
  listSessions,
  loadSession,
  saveSessionThrottled,
  setSessionNote as persistSessionNote,
  normalizeSessionNote,
} from './session.js';
import {
  collectSessionArtifacts,
  deleteSession as deleteSessionDisk,
  type DeleteSessionResult,
  type SessionArtifacts,
} from './session-delete.js';
import { getJobRegistry } from './spawn/job-registry.js';
import {
  buildWorkflowCheckpoint,
  formatWorkflowCheckpoint,
  workflowConfirmEndEvent,
  workflowConfirmStartEvent,
  type WorkflowCheckpointInfo,
} from './workflow-checkpoint.js';
import type { AgentPluginConfig } from './plugins/types.js';
import type {
  AgentConfig,
  SessionFile,
  SessionLlmOverride,
  SessionMeta,
  SessionOverview,
  SpawnLifecycleEvent,
  TaskSummaryDoc,
  WorkspacePromptBundle,
} from './types.js';
import {
  formatHandoffInjection,
  getHandoffPath,
  readHandoffFile,
  writeHandoffFile,
} from './handoff.js';
import {
  buildSpawnPresetEntries,
  listOrphanAgentFiles,
  type OrphanAgentFile,
  type SpawnPresetEntry,
} from './spawn/preset-query.js';
import {
  countRunningJobs,
  formatJobEventsTail,
  formatJobList,
  formatJobStatus,
  getJobStatusDetail,
  listSpawnJobs,
  toJobListEntry,
  type ListJobsOptions,
} from './spawn/job-query.js';
import type { SpawnJobMeta } from './spawn/job-store.js';
import { listWorkflowMetaForCwd } from './workflow/catalog.js';
import { resolveWorkflowRef } from './workflow/load-workflow.js';
import { runWorkflow } from './workflow/runner.js';
import { appendTaskTranscript } from './session-transcript.js';
import { flushTranscriptWrites } from './session-transcript-queue.js';
import {
  configureActionWriteQueue,
  flushActionWrites,
  setActiveActionSessionId,
} from './action-write-queue.js';
import { formatTurnIoSummary, isActionIoMetricsEnabled } from './action-io-metrics.js';
import type { TaskBlock } from './task-tracker.js';
import {
  formatImportResult,
  importProjectLocalSessions as importProjectLocalSessionsFromDisk,
  type ImportProjectLocalSessionsResult,
} from './session-import.js';
import {
  addWorkspaceGrant,
  applySessionWorkspaceState,
  buildSessionWorkspaceState,
  configureSessionStore,
  findGrantForPath,
  formatWorkspaceGrantLine,
  getCwdCapabilityPolicy,
  getPrimaryRoot,
  getProjectId,
  getSessionStoreMode,
  getWorkspaceGrants,
  getWorkspaceRoot,
  projectDisplayName,
  resolveMaybeRelative,
  revokeWorkspaceGrant,
  setWorkspaceRoot,
  type WorkspaceGrant,
  type WorkspaceGrantMode,
} from './workspace.js';
import {
  loadWorkspacePromptBundle,
  workspacePromptRunStartMeta,
} from './agent-prompt.js';
import {
  buildRunStartLlmMeta,
  listModelsForProfile,
  listProfileNames,
  resolveLlmBinding,
  validateModelForProfile,
  type ResolvedLlmBinding,
} from './llm-profiles.js';
import { configureAgentLlmBinding } from './llm-fallback.js';
import {
  resolveMergedModelIds,
  type MergedModelListSource,
} from './llm-models-remote.js';
import { listReasoningLevels, resolveReasoningPatch } from './llm-reasoning.js';
import {
  BridgeStepForwarder,
  buildUserTaskMessage,
  createMessageBridge,
  createSystemEventHub,
  isSyntheticSystemEventPrompt,
  setGlobalSystemEventHub,
  type MessageBridge,
  type SessionNotifyConfig,
  type SystemEvent,
  type SystemEventHub,
} from './hooks/index.js';

export type { SessionLlmOverride };
export type { MessageBridge } from './hooks/index.js';

export interface SessionProfileChoice {
  name: string;
  displayName?: string;
  available: boolean;
  unavailableReason?: string;
  active: boolean;
}

export interface SessionModelChoice {
  model: string;
  active: boolean;
}

export interface SessionModelListResult {
  choices: SessionModelChoice[];
  source: MergedModelListSource;
  remoteError?: string;
}

export interface SessionReasoningChoice {
  level: string;
  active: boolean;
}

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || fallback;
}

export interface BuildConfigOptions {
  cwd: string;
  allowShell?: boolean;
  allowWeb?: boolean;
  loadSkills?: string[];
}

export function buildAgentConfig(opts: BuildConfigOptions): {
  config: AgentConfig;
  pluginConfig: AgentPluginConfig;
} {
  const pluginConfig = loadAgentPluginConfig(opts.cwd);
  if (opts.loadSkills && opts.loadSkills.length > 0) {
    pluginConfig.loaded_skills = [
      ...new Set([...(pluginConfig.loaded_skills ?? []), ...opts.loadSkills]),
    ];
  }

  const keepInlineTurns = pluginConfig.pointerize_policy?.keep_inline_turns ?? 2;
  const recallAutoFullMaxChars = pluginConfig.recall_policy?.auto_full_max_chars ?? 24_000;
  const previewPolicy = previewPolicyFromPointerize(pluginConfig.pointerize_policy);
  const loopGuardMode = parseLoopGuardMode(env('LOOP_GUARD', 'inject'));

  const config: AgentConfig = {
    apiKey: '',
    baseUrl: '',
    model: '',
    maxTurns: Number(env('MAX_TURNS', '0')),
    cwd: opts.cwd,
    allowShell: opts.allowShell ?? false,
    allowWeb: opts.allowWeb ?? false,
    webFetchPolicy: pluginConfig.web_fetch_policy,
    webSearchPolicy: pluginConfig.web_search,
    loopGuard: {
      enabled: loopGuardMode !== 'off',
      mode: loopGuardMode,
      hardCeiling: Number(env('LOOP_HARD_CEILING', '200')),
    },
    keepInlineTurns,
    recallAutoFullMaxChars,
    previewPolicy,
    spawnPolicy: pluginConfig.spawn_policy,
    llmPluginConfig: pluginConfig,
  };

  configureAgentLlmBinding(config, pluginConfig);

  return { config, pluginConfig };
}

export type RuntimeListener = (event: RuntimeEvent) => void;

export type WorkflowConfirmFn = (
  info: WorkflowCheckpointInfo,
  signal?: AbortSignal,
) => Promise<boolean>;

export interface AgentRuntimeOptions {
  cwd: string;
  resumeSessionId?: string;
  /** Resume most recently active session when resumeSessionId omitted. */
  resumeLatest?: boolean;
  loadSkills?: string[];
  allowShell?: boolean;
  allowWeb?: boolean;
  /** TUI entry: shell defaults on unless overridden. */
  tuiMode?: boolean;
  jsonEvents?: boolean;
  /** Inject handoff from session id (or `last`) on first task in a new session. */
  loadHandoffFrom?: string;
  /** TUI: do not create a session until first task, /new, or /resume. */
  deferSession?: boolean;
  /**
   * Optional MessageBridge (L3). Default empty bridge (emit is free with zero sinks).
   * Does not replace RuntimeEvent / --json-events.
   */
  messageBridge?: MessageBridge;
}

export class AgentRuntime {
  config: AgentConfig;
  pluginConfig: AgentPluginConfig;
  session: SessionFile | null = null;

  private listeners = new Set<RuntimeListener>();
  private abortController = new AbortController();
  private armedWorkflowPath: string | null = null;
  private sessionDirty = false;
  private running = false;
  private readonly jsonEvents: boolean;
  private readonly useStream: boolean;
  private readonly messageBridge: MessageBridge;
  private readonly bridgeStepForwarder: BridgeStepForwarder;
  private readonly systemEventHub: SystemEventHub;
  private inboundDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private inboundAutoRunBusy = false;
  readonly permissionGate = new PermissionGate();
  private workflowConfirmFn?: WorkflowConfirmFn;
  private pendingHandoffPrefix: string | null = null;
  private runWorkspacePrompt: WorkspacePromptBundle | null = null;
  private sessionLlmOverride: SessionLlmOverride = {};
  private modelListGeneration = 0;

  constructor(opts: AgentRuntimeOptions) {
    // Load plugin first so session_store / agent_home apply before sessionsDir().
    const built = buildAgentConfig({
      cwd: opts.cwd,
      loadSkills: opts.loadSkills,
      allowShell: opts.tuiMode
        ? opts.allowShell !== false
        : (opts.allowShell ?? false) || env('ALLOW_SHELL') === '1',
      allowWeb: (opts.allowWeb ?? false) || env('ALLOW_WEB') === '1',
    });
    this.pluginConfig = built.pluginConfig;
    configureSessionStore({
      mode: this.pluginConfig.session_store ?? 'project_local',
      agentHome: this.pluginConfig.agent_home,
      capabilityPolicy:
        this.pluginConfig.cwd_switch?.default_capability_policy ?? 'strict',
      cwd: opts.cwd,
    });
    this.config = built.config;
    this.config.workspaceGrants = getWorkspaceGrants();
    this.jsonEvents = opts.jsonEvents ?? false;
    this.useStream = env('STREAM', '1') !== '0';
    this.messageBridge = opts.messageBridge ?? createMessageBridge();
    this.bridgeStepForwarder = new BridgeStepForwarder(
      this.messageBridge,
      () => this.session?.session_id,
      { source: 'main' },
    );
    this.systemEventHub = createSystemEventHub({
      bridge: this.messageBridge,
      config: this.pluginConfig.session_notify as SessionNotifyConfig | undefined,
      onEvent: (ev) => this.emitSystemEventRuntime(ev),
      onMaybeAutoRun: (sessionId) => this.scheduleInboundDrain(sessionId),
    });
    setGlobalSystemEventHub(this.systemEventHub);
    this.permissionGate.setLifecycle((event) => this.emit(event));

    configureActionWriteQueue({
      onFlush: (info) => {
        this.emit({
          type: 'action_flush',
          flush_ms: info.flush_ms,
          count: info.count,
          pending: info.pending,
        });
      },
    });

    const deferSession = opts.deferSession === true;

    if (opts.resumeSessionId) {
      const loaded = loadSession(opts.resumeSessionId);
      if (!loaded) {
        throw new Error(`Session not found: ${opts.resumeSessionId}`);
      }
      this.attachSession(loaded);
    } else if (opts.resumeLatest) {
      const latest = getLatestSession(env('USER_ID'));
      if (!latest) {
        if (!deferSession) {
          this.attachSession(createSession(env('USER_ID') ?? 'user_default'), true);
        }
      } else {
        const loaded = loadSession(latest.session_id);
        if (!loaded) {
          throw new Error(`Session not found: ${latest.session_id}`);
        }
        this.attachSession(loaded);
      }
    } else if (!deferSession) {
      this.attachSession(createSession(env('USER_ID') ?? 'user_default'), true);
    }

    if (opts.loadHandoffFrom) {
      this.bootstrapHandoff(opts.loadHandoffFrom);
    }
  }

  private bootstrapHandoff(sessionIdOrLast: string): void {
    let sessionId = sessionIdOrLast;
    if (sessionId === 'last') {
      const prior = listSessions(env('USER_ID'));
      const currentId = this.session?.session_id;
      const other = currentId
        ? prior.find((s) => s.session_id !== currentId)
        : prior[0];
      if (!other) return;
      sessionId = other.session_id;
    }
    const content = readHandoffFile(sessionId);
    if (content) {
      this.pendingHandoffPrefix = formatHandoffInjection(content);
    }
  }

  setWorkflowConfirmFn(fn: WorkflowConfirmFn | undefined): void {
    this.workflowConfirmFn = fn;
  }

  hasActiveSession(): boolean {
    return this.session !== null;
  }

  /** Display label for TUI banner (no session until first task / /new / /resume). */
  sessionLabel(): string {
    return this.session?.session_id ?? '(none)';
  }

  /** Create a session on first task when TUI started with deferSession. */
  ensureSession(): SessionFile {
    if (!this.session) {
      this.attachSession(createSession(env('USER_ID') ?? 'user_default'), true);
    }
    return this.session!;
  }

  private attachSession(session: SessionFile, dirty = false): void {
    this.session = session;
    this.sessionDirty = dirty;
    this.restoreSessionLlmOverrideFromSession(session);
    if (session.workspace) {
      applySessionWorkspaceState(session.workspace);
      this.config.cwd = getWorkspaceRoot();
      this.config.workspaceGrants = getWorkspaceGrants();
    } else {
      // Legacy session: stamp workspace snapshot without moving primary if project_local
      session.workspace = buildSessionWorkspaceState();
      this.config.workspaceGrants = getWorkspaceGrants();
      this.sessionDirty = true;
    }
  }

  private normalizeSessionLlmOverride(
    raw?: SessionLlmOverride,
  ): SessionLlmOverride | undefined {
    if (!raw) return undefined;
    const normalized: SessionLlmOverride = {};
    const profileName = raw.profileName?.trim();
    const model = raw.model?.trim();
    const reasoningLevel = raw.reasoningLevel?.trim();
    if (profileName) normalized.profileName = profileName;
    if (model) normalized.model = model;
    if (reasoningLevel) normalized.reasoningLevel = reasoningLevel;
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private restoreSessionLlmOverrideFromSession(session?: SessionFile | null): void {
    const normalized = this.normalizeSessionLlmOverride(session?.llm_override);
    this.sessionLlmOverride = normalized ?? {};
    this.bumpModelListGeneration();
  }

  private persistSessionLlmOverride(forceSave = true): void {
    if (!this.session) return;
    const normalized = this.normalizeSessionLlmOverride(this.sessionLlmOverride);
    if (normalized) {
      this.session.llm_override = normalized;
    } else {
      delete this.session.llm_override;
    }
    this.sessionDirty = true;
    if (forceSave) {
      this.saveIfDirty(true);
    }
  }

  resumeLatestSession(): boolean {
    const latest = getLatestSession(env('USER_ID'));
    if (!latest) return false;
    return this.resumeSession(latest.session_id);
  }

  async initialize(): Promise<void> {
    await ensureToolRegistry(this.config.cwd, this.pluginConfig);
  }

  onEvent(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** L3 MessageBridge (IM / multi-UI reserved). Zero sinks by default. */
  getMessageBridge(): MessageBridge {
    return this.messageBridge;
  }

  /** SPEC_JOB_SESSION_NOTIFY hub (bridge + inbound queue). */
  getSystemEventHub(): SystemEventHub {
    return this.systemEventHub;
  }

  /**
   * Emit user task full text to MessageBridge (H1 payload).
   * Same path as runTask / runWorkflowTask; does not invoke the LLM.
   */
  publishUserTaskToBridge(prompt: string): void {
    const session = this.ensureSession();
    this.messageBridge.emit(buildUserTaskMessage(session.session_id, prompt));
  }

  private emitSystemEventRuntime(ev: SystemEvent): void {
    this.emit({
      type: 'system_event',
      kind: ev.kind,
      session_id: ev.session_id,
      event_id: ev.event_id,
      job_id: ev.job_id,
      workflow: ev.workflow,
      still_running: ev.still_running,
      summary: ev.summary_line ?? ev.handback_reason ?? ev.digest?.slice(0, 200),
    });
  }

  /** Debounced drain of system-event inbound queue → optional auto_run. */
  private scheduleInboundDrain(sessionId?: string): void {
    const cfg = this.systemEventHub.getConfig();
    const ms =
      cfg.merge === 'per_event'
        ? 0
        : Math.max(0, cfg.debounce_ms ?? 800);
    if (this.inboundDrainTimer) {
      clearTimeout(this.inboundDrainTimer);
      this.inboundDrainTimer = null;
    }
    this.inboundDrainTimer = setTimeout(() => {
      this.inboundDrainTimer = null;
      void this.drainInboundAutoRun(sessionId);
    }, ms);
  }

  private async drainInboundAutoRun(sessionIdHint?: string): Promise<void> {
    if (this.running || this.inboundAutoRunBusy) return;
    const cfg = this.systemEventHub.getConfig();
    if (!cfg.auto_run) return;

    const session = this.session;
    if (!session) return;
    const sessionId = sessionIdHint ?? session.session_id;
    if (sessionId !== session.session_id) return;

    const items = this.systemEventHub.inbound.drain(sessionId, {
      onlyAutoRun: true,
    });
    if (items.length === 0) return;

    // runSingleTask does not read armedWorkflowPath — leave arm intact for the
    // user's next real message (do not silently discard one-shot arm).
    this.inboundAutoRunBusy = true;
    try {
      const prompt = this.systemEventHub.formatSyntheticPrompt(items);
      await this.runSingleTask(prompt);
    } catch {
      // Errors already emitted from runSingleTask; do not rethrow into job path.
    } finally {
      this.inboundAutoRunBusy = false;
      // Nested settles while we ran
      if (this.systemEventHub.inbound.pendingCount(session.session_id) > 0) {
        this.scheduleInboundDrain(session.session_id);
      }
    }
  }

  private notifyWorkflowSettled(opts: {
    workflow: string;
    workflowPath?: string;
    sessionId: string;
    digest: string;
    handbackReason?: string;
  }): void {
    const kind = opts.handbackReason ? 'workflow_handback' : 'workflow_complete';
    this.systemEventHub.notify({
      kind,
      timestamp: Date.now(),
      session_id: opts.sessionId,
      event_id: `wf:${opts.workflow}:${kind}:${Date.now()}`,
      workflow: opts.workflow,
      workflow_path: opts.workflowPath,
      digest: opts.digest,
      handback_reason: opts.handbackReason,
    });
  }

  private emit(event: RuntimeEvent): void {
    if (this.jsonEvents) {
      emitJsonEvent(event);
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** RuntimeEvent / --json-events only (used as nestedStepSink for spawn). */
  private emitStepEvent = (event: AgentStepEvent): void => {
    this.emit(event);
  };

  private onStep = (event: AgentStepEvent): void => {
    // MB-2/MB-3: main-session bridge (source=main). Spawn/job use their own forwarders.
    this.bridgeStepForwarder.onStep(event);
    this.emitStepEvent(event);
  };

  private onSpawnLifecycle = (event: SpawnLifecycleEvent): void => {
    if (event.phase === 'start') {
      this.emit({ type: 'spawn_start', preset: event.preset });
      return;
    }
    this.emit({
      type: 'spawn_end',
      preset: event.preset,
      ok: event.ok,
      detail: event.detail,
    });
  };

  private beginRunWorkspacePrompt(): WorkspacePromptBundle {
    const bundle = loadWorkspacePromptBundle(this.config.cwd);
    this.runWorkspacePrompt = bundle;
    return bundle;
  }

  hasSessionLlmOverride(): boolean {
    const { profileName, model, reasoningLevel } = this.sessionLlmOverride;
    return (
      (profileName?.trim() ?? '') !== '' ||
      (model?.trim() ?? '') !== '' ||
      (reasoningLevel?.trim() ?? '') !== ''
    );
  }

  getSessionReasoningLevel(): string | undefined {
    return this.sessionLlmOverride.reasoningLevel?.trim() || undefined;
  }

  getSessionLlmOverride(): Readonly<SessionLlmOverride> {
    return { ...this.sessionLlmOverride };
  }

  private clearSessionLlmOverride(persist = true): void {
    this.sessionLlmOverride = {};
    this.bumpModelListGeneration();
    if (persist) {
      this.persistSessionLlmOverride();
    }
  }

  private bumpModelListGeneration(): void {
    this.modelListGeneration++;
  }

  private resolveRunLlmBinding(): ResolvedLlmBinding {
    const opts: { profileName?: string; model?: string } = {};
    const profileName = this.sessionLlmOverride.profileName?.trim();
    const model = this.sessionLlmOverride.model?.trim();
    if (profileName) {
      opts.profileName = profileName;
    }
    if (model) {
      opts.model = model;
    }
    return resolveLlmBinding(this.pluginConfig, opts);
  }

  getEffectiveProfileName(): string {
    return this.resolveRunLlmBinding().profileName;
  }

  formatSessionLlmShortLine(): string {
    const binding = this.resolveRunLlmBinding();
    const star = this.hasSessionLlmOverride() ? '*' : '';
    const reasoning = this.getSessionReasoningLevel();
    const r = reasoning ? ` r:${reasoning}` : '';
    return `llm:${binding.profileName}/${binding.model}${star}${r}`;
  }

  formatSessionLlmStatus(): string {
    const binding = this.resolveRunLlmBinding();
    const tag = `${binding.profileName}/${binding.model}`;
    const override = this.hasSessionLlmOverride() ? ' (session override)' : '';
    const reasoning = this.getSessionReasoningLevel();
    const reasoningPart = reasoning ? ` reasoning=${reasoning}` : '';
    const cache =
      binding.cache?.mode && binding.cache.mode !== 'off'
        ? ` cache=${binding.cache.mode}`
        : '';
    return `llm: ${tag}${override}${reasoningPart}${cache} — main agent only; spawn jobs use preset binding`;
  }

  listSessionProfileChoices(): SessionProfileChoice[] {
    const effectiveProfile = this.getEffectiveProfileName();
    const names = listProfileNames(this.pluginConfig);
    return names.map((name) => {
      const binding = resolveLlmBinding(this.pluginConfig, { profileName: name });
      const profile = this.pluginConfig.api_profiles?.[name];
      return {
        name,
        displayName: profile?.display_name ?? (name === '__env__' ? 'Environment' : undefined),
        available: binding.available,
        unavailableReason: binding.unavailableReason,
        active: name === effectiveProfile,
      };
    });
  }

  listSessionModelChoices(): SessionModelChoice[] {
    const profileName = this.getEffectiveProfileName();
    const activeModel = this.resolveRunLlmBinding().model;
    return listModelsForProfile(this.pluginConfig, profileName).map((model) => ({
      model,
      active: model === activeModel,
    }));
  }

  /** Static list + optional GET /models enrich (G2-d); discards stale fetch on profile change. */
  async listSessionModelChoicesAsync(): Promise<SessionModelListResult> {
    const generationAtStart = this.modelListGeneration;
    const binding = this.resolveRunLlmBinding();
    const activeModel = binding.model;
    const staticModels = listModelsForProfile(this.pluginConfig, binding.profileName);

    const merged = await resolveMergedModelIds(staticModels, binding);

    if (generationAtStart !== this.modelListGeneration) {
      return {
        choices: this.listSessionModelChoices(),
        source: 'static',
      };
    }

    return {
      choices: merged.models.map((model) => ({
        model,
        active: model === activeModel,
      })),
      source: merged.source,
      remoteError: merged.remoteError,
    };
  }

  setSessionLlmProfile(profileName: string): { ok: boolean; message: string } {
    const trimmed = profileName.trim();
    if (!trimmed) {
      return { ok: false, message: 'error: profile name required' };
    }
    try {
      const binding = resolveLlmBinding(this.pluginConfig, { profileName: trimmed });
      if (!binding.available) {
        return {
          ok: false,
          message: `error: ${binding.unavailableReason ?? `profile "${trimmed}" unavailable`}`,
        };
      }
      const profileChanged = this.getEffectiveProfileName() !== trimmed;
      const preservedModel = profileChanged ? undefined : this.sessionLlmOverride.model?.trim();
      const preservedReasoning = profileChanged
        ? undefined
        : this.sessionLlmOverride.reasoningLevel?.trim();
      this.sessionLlmOverride = {
        profileName: trimmed,
        ...(preservedModel ? { model: preservedModel } : {}),
        ...(preservedReasoning ? { reasoningLevel: preservedReasoning } : {}),
      };
      this.persistSessionLlmOverride();
      const models = listModelsForProfile(this.pluginConfig, trimmed);
      const hint =
        models.length > 1
          ? ` Models: ${models.join(', ')} (use /model)`
          : '';
      const displayModel = preservedModel ?? binding.model;
      this.bumpModelListGeneration();
      return {
        ok: true,
        message: `profile → ${trimmed}/${displayModel} (next task)${hint}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `error: ${msg}` };
    }
  }

  setSessionLlmModel(model: string): { ok: boolean; message: string } {
    const trimmed = model.trim();
    if (!trimmed) {
      return { ok: false, message: 'error: model id required' };
    }
    try {
      const profileName = this.getEffectiveProfileName();
      const catalogBinding = resolveLlmBinding(this.pluginConfig, { profileName });
      const validation = validateModelForProfile(
        this.pluginConfig,
        profileName,
        trimmed,
        { binding: catalogBinding },
      );
      if (!validation.ok) {
        return { ok: false, message: validation.message };
      }
      const binding = resolveLlmBinding(this.pluginConfig, {
        profileName,
        model: trimmed,
      });
      if (!binding.available) {
        return {
          ok: false,
          message: `error: ${binding.unavailableReason ?? 'profile unavailable'}`,
        };
      }
      this.sessionLlmOverride = {
        ...this.sessionLlmOverride,
        model: trimmed,
      };
      this.persistSessionLlmOverride();
      return {
        ok: true,
        message: `model → ${profileName}/${trimmed} (next task)`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `error: ${msg}` };
    }
  }

  resetSessionLlmOverride(): void {
    this.clearSessionLlmOverride();
  }

  resetSessionLlmModel(): void {
    this.pruneSessionLlmOverrideField('model');
  }

  listSessionReasoningChoices(): SessionReasoningChoice[] {
    const binding = this.resolveRunLlmBinding();
    const active = this.getSessionReasoningLevel();
    return listReasoningLevels(binding.reasoningMap).map((level) => ({
      level,
      active: level === active,
    }));
  }

  setSessionReasoningLevel(level: string): { ok: boolean; message: string } {
    const trimmed = level.trim();
    if (!trimmed) {
      return { ok: false, message: 'error: reasoning level required' };
    }
    const binding = this.resolveRunLlmBinding();
    const patch = resolveReasoningPatch(binding.reasoningMap, trimmed);
    if (!patch) {
      const available = listReasoningLevels(binding.reasoningMap);
      if (available.length === 0) {
        return {
          ok: false,
          message: `error: profile "${binding.profileName}" has no reasoning_map`,
        };
      }
      return {
        ok: false,
        message: `error: unknown reasoning level "${trimmed}" (available: ${available.join(', ')})`,
      };
    }
    this.sessionLlmOverride = {
      ...this.sessionLlmOverride,
      reasoningLevel: trimmed,
    };
    this.persistSessionLlmOverride();
    return {
      ok: true,
      message: `reasoning → ${binding.profileName}/${trimmed} (next task)`,
    };
  }

  resetSessionReasoningLevel(): void {
    this.pruneSessionLlmOverrideField('reasoningLevel');
  }

  private pruneSessionLlmOverrideField(field: 'model' | 'reasoningLevel'): void {
    delete this.sessionLlmOverride[field];
    if (!this.hasSessionLlmOverride()) {
      this.clearSessionLlmOverride();
      return;
    }
    this.persistSessionLlmOverride();
  }

  private webSearchTaskState = { externalCount: 0 };

  private resetWebSearchTaskBudget(): void {
    this.webSearchTaskState.externalCount = 0;
  }

  private buildRunConfig(signal: AbortSignal): AgentConfig {
    const session = this.ensureSession();
    const runConfig: AgentConfig = {
      ...this.config,
      sessionId: session.session_id,
      abortSignal: signal,
      permissionGate: this.permissionGate,
      spawnLifecycle: this.onSpawnLifecycle,
      workspacePrompt: this.runWorkspacePrompt ?? undefined,
      webSearchTaskState: this.webSearchTaskState,
      messageBridge: this.messageBridge,
      workspaceGrants: getWorkspaceGrants(),
      // Nested spawn steps → RuntimeEvent only (MB-4 bridge tags spawn/job separately).
      nestedStepSink: this.emitStepEvent,
    };
    const override = this.getSessionLlmOverride();
    configureAgentLlmBinding(runConfig, this.pluginConfig, {
      profileName: override.profileName?.trim(),
      model: override.model?.trim(),
    });
    const reasoningLevel = override.reasoningLevel?.trim();
    if (reasoningLevel) {
      runConfig.sessionReasoningLevel = reasoningLevel;
    }
    return runConfig;
  }

  /** run_start.llm uses the same binding as the upcoming agent run (G2-a). */
  private emitRunStart(
    sessionId: string,
    signal: AbortSignal,
    wsMeta: ReturnType<typeof workspacePromptRunStartMeta>,
  ): void {
    const runConfig = this.buildRunConfig(signal);
    const llmMeta = buildRunStartLlmMeta(
      runConfig.llm,
      runConfig.sessionReasoningLevel,
      {
        enabled: runConfig.llmProfileFallbackEnabled !== false,
        disabledReason: runConfig.llmProfileFallbackDisabledReason,
      },
    );
    const llm =
      llmMeta && this.hasSessionLlmOverride()
        ? { ...llmMeta, session_override: true }
        : llmMeta;
    this.emit({
      type: 'run_start',
      session_id: sessionId,
      cwd: this.config.cwd,
      agent_md: wsMeta.agent_md,
      memory: wsMeta.memory,
      ...(llm ? { llm } : {}),
    });
  }

  listSessions(): SessionMeta[] {
    return listSessions();
  }

  /**
   * Set or clear a human note on a session (persisted).
   * Also patches the in-memory active session when ids match.
   */
  setSessionNote(sessionId: string, note: string | undefined | null): boolean {
    const ok = persistSessionNote(sessionId, note);
    if (!ok) return false;
    if (this.session?.session_id === sessionId) {
      const normalized = normalizeSessionNote(note);
      if (normalized) this.session.note = normalized;
      else delete this.session.note;
      // Disk already written by persistSessionNote; avoid dirty thrash.
      this.sessionDirty = false;
    }
    return true;
  }

  /** Inventory disk artifacts for a session (actions, spawn, jobs, …). */
  collectSessionArtifacts(sessionId: string): SessionArtifacts {
    return collectSessionArtifacts(sessionId);
  }

  /**
   * Delete a main session and its bound cold storage / spawn trees / jobs.
   * Refuses when this session is the active run target.
   * If the deleted id is the current idle session, starts a fresh empty session.
   */
  deleteSession(sessionId: string): DeleteSessionResult {
    const id = sessionId.trim();
    if (this.isRunning() && this.session?.session_id === id) {
      return {
        ok: false,
        reason: 'session is running; /stop first',
        artifacts: collectSessionArtifacts(id),
      };
    }

    const wasCurrent = this.session?.session_id === id;
    if (wasCurrent) {
      this.saveIfDirty(true);
      setActiveActionSessionId(undefined);
    }

    const result = deleteSessionDisk(id, {
      cancelJob: (jobId) => getJobRegistry().cancel(jobId),
    });

    if (result.ok && wasCurrent) {
      this.newSession();
    }
    return result;
  }

  resumeSession(id: string): boolean {
    const loaded = loadSession(id);
    if (!loaded) return false;
    this.attachSession(loaded);
    return true;
  }

  newSession(): void {
    this.attachSession(createSession(env('USER_ID') ?? 'user_default'), true);
    this.sessionLlmOverride = {};
    this.bumpModelListGeneration();
    this.persistSessionLlmOverride();
  }

  /** Drop in-flight messages; completed task summaries remain. */
  clearCurrentContext(): boolean {
    if (!this.session) return false;
    this.session.current_messages = [];
    this.sessionDirty = true;
    return true;
  }

  hasPendingHandoff(): boolean {
    return this.pendingHandoffPrefix !== null;
  }

  /** Write `.sessions/handoff_<session_id>.md` for the current session. */
  writeHandoff(): string | null {
    if (!this.session) return null;
    this.saveIfDirty(true);
    return writeHandoffFile(this.session);
  }

  /** Queue handoff content for injection into the next task prompt. */
  loadHandoffForNextTask(sessionId?: string): string | null {
    const sid = sessionId ?? this.session?.session_id;
    if (!sid) return null;
    const content = readHandoffFile(sid);
    if (!content) return null;
    this.pendingHandoffPrefix = formatHandoffInjection(content);
    return getHandoffPath(sid);
  }

  /**
   * Write handoff from current session, open a new session, queue handoff for next task.
   */
  newSessionWithHandoff(): { path: string; fromSessionId: string } | null {
    if (!this.session) return null;
    this.saveIfDirty(true);
    const fromSession = this.session;
    const path = writeHandoffFile(fromSession);
    const content = readHandoffFile(fromSession.session_id)!;
    this.newSession();
    this.pendingHandoffPrefix = formatHandoffInjection(content);
    return { path, fromSessionId: fromSession.session_id };
  }

  private consumeHandoffPrompt(prompt: string): string {
    if (!this.pendingHandoffPrefix) return prompt;
    const injection = this.pendingHandoffPrefix;
    this.pendingHandoffPrefix = null;
    return `${injection}\n\n${prompt}`;
  }

  setAllowShell(on: boolean): void {
    this.config.allowShell = on;
    this.emit({ type: 'runtime', shell: on, web: this.config.allowWeb });
  }

  setAllowWeb(on: boolean): void {
    this.config.allowWeb = on;
    this.emit({ type: 'runtime', shell: this.config.allowShell, web: on });
  }

  loadSkill(name: string): void {
    const skills = this.pluginConfig.loaded_skills ?? [];
    if (!skills.includes(name)) {
      this.pluginConfig.loaded_skills = [...skills, name];
    }
  }

  getLoadedSkills(): string[] {
    return [...(this.pluginConfig.loaded_skills ?? [])];
  }

  /**
   * Change active tool cwd. Session identity stays; storage bucket depends on session_store.
   * Path must be under an existing grant, or pass `grantIfMissing` to add a session grant.
   */
  async setCwd(
    path: string,
    opts?: {
      grantIfMissing?: boolean;
      grantMode?: WorkspaceGrantMode;
      grantShell?: boolean;
      grantWeb?: boolean;
    },
  ): Promise<void> {
    const resolved = resolveMaybeRelative(this.config.cwd, path);
    let existing = findGrantForPath(resolved);

    if (!existing) {
      if (!opts?.grantIfMissing) {
        throw new Error(
          `path not in workspace grants: ${resolved}. Use /cwd allow <path> first.`,
        );
      }
      addWorkspaceGrant({
        root: resolved,
        mode: opts.grantMode ?? 'read_write',
        scope: 'session',
        shell: opts.grantShell,
        web: opts.grantWeb,
        granted_at: Date.now(),
      });
      existing = findGrantForPath(resolved);
    }
    void existing;

    const prevCwd = this.config.cwd;
    setWorkspaceRoot(resolved);
    this.config.cwd = getWorkspaceRoot();
    this.config.workspaceGrants = getWorkspaceGrants();

    // Reload project config from new active cwd (Agent.md / agent.json overlay)
    this.pluginConfig = loadAgentPluginConfig(resolved);
    // Re-apply session store so agent_home mode is not wiped by project agent.json omission
    configureSessionStore({
      mode: this.pluginConfig.session_store ?? getSessionStoreMode(),
      agentHome: this.pluginConfig.agent_home,
      capabilityPolicy:
        this.pluginConfig.cwd_switch?.default_capability_policy ??
        getCwdCapabilityPolicy(),
    });
    await reinitializeToolRegistry(resolved, this.pluginConfig);

    if (this.session) {
      if (!this.session.workspace) {
        this.session.workspace = buildSessionWorkspaceState();
      } else {
        this.session.workspace = {
          ...this.session.workspace,
          active_cwd: getWorkspaceRoot(),
          workspace_grants: getWorkspaceGrants(),
        };
      }
      this.sessionDirty = true;
      this.saveIfDirty(true);
    }

    // Capability policy on switch
    const policy = getCwdCapabilityPolicy();
    const grant = findGrantForPath(resolved);
    if (policy === 'strict' || policy === 'inherit_grant_only') {
      if (policy === 'inherit_grant_only' || grant) {
        if (grant && !grant.shell) {
          // leave allowShell as-is only if inherit_session — strict drops session shell for safety on foreign roots
        }
      }
      if (policy === 'strict' && grant && resolve(grant.root) !== resolve(getPrimaryRoot())) {
        // Foreign root: do not auto-enable shell/web; user must re-approve or grant.shell
        if (!grant.shell) this.config.allowShell = this.permissionGate.hasAlwaysGrant('shell');
        if (!grant.web) this.config.allowWeb = this.permissionGate.hasAlwaysGrant('web');
      }
    }
    void prevCwd;
  }

  allowWorkspacePath(opts: {
    path: string;
    mode?: WorkspaceGrantMode;
    scope?: 'once' | 'session' | 'sticky';
    shell?: boolean;
    web?: boolean;
    label?: string;
  }): WorkspaceGrant {
    const root = resolveMaybeRelative(this.config.cwd, opts.path);
    const grant = addWorkspaceGrant({
      root,
      mode: opts.mode ?? 'read_write',
      scope: opts.scope ?? 'session',
      shell: opts.shell,
      web: opts.web,
      granted_at: Date.now(),
      label: opts.label,
    });
    this.config.workspaceGrants = getWorkspaceGrants();
    if (this.session?.workspace) {
      this.session.workspace.workspace_grants = getWorkspaceGrants();
      this.sessionDirty = true;
      this.saveIfDirty(true);
    }
    return grant;
  }

  listWorkspaceGrants(): WorkspaceGrant[] {
    return getWorkspaceGrants();
  }

  /**
   * SW-6: copy `<projectRoot>/.sessions` session files into agent_home by-project bucket.
   * Does not switch session_store; set agent.json session_store=agent_home to use dest.
   */
  importProjectLocalSessions(opts?: {
    projectRoot?: string;
    overwrite?: boolean;
  }): ImportProjectLocalSessionsResult {
    return importProjectLocalSessionsFromDisk({
      projectRoot: opts?.projectRoot ?? getPrimaryRoot(),
      overwrite: opts?.overwrite,
    });
  }

  revokeWorkspacePath(path: string): boolean {
    const root = resolveMaybeRelative(this.config.cwd, path);
    const ok = revokeWorkspaceGrant(root);
    this.config.workspaceGrants = getWorkspaceGrants();
    if (this.session?.workspace) {
      this.session.workspace.workspace_grants = getWorkspaceGrants();
      this.sessionDirty = true;
      this.saveIfDirty(true);
    }
    return ok;
  }

  describeWorkspace(): string {
    const lines = [
      `session_store: ${getSessionStoreMode()}`,
      `project: ${projectDisplayName()} (${getProjectId()})`,
      `primary: ${getPrimaryRoot()}`,
      `active_cwd: ${getWorkspaceRoot()}`,
      `capability_policy: ${getCwdCapabilityPolicy()}`,
      'grants:',
      ...getWorkspaceGrants().map((g) => `  - ${formatWorkspaceGrantLine(g)}`),
    ];
    return lines.join('\n');
  }

  armWorkflow(path: string | null): void {
    this.armedWorkflowPath = path;
  }

  getArmedWorkflow(): string | null {
    return this.armedWorkflowPath;
  }

  listWorkflows(): string[] {
    return this.listWorkflowMeta().map((w) => w.name);
  }

  listWorkflowMeta() {
    const dirs = [
      ...(this.pluginConfig.workflow_dirs ?? []),
      'workflows',
    ];
    return listWorkflowMetaForCwd(this.config.cwd, dirs);
  }

  getSessionOverview(sessionId: string): SessionOverview | null {
    const session = loadSession(sessionId);
    if (!session) return null;
    return buildSessionOverview(session);
  }

  /** Session for /actions; defaults to active session. */
  resolveLogSession(sessionId?: string): SessionFile | null {
    if (sessionId) return loadSession(sessionId);
    return this.session;
  }

  /** Session for /transcript — same resolution as /actions. */
  resolveHistorySession(sessionId?: string): SessionFile | null {
    return this.resolveLogSession(sessionId);
  }

  private handleTaskComplete(
    session: SessionFile,
    summary: TaskSummaryDoc,
    taskBlock: TaskBlock,
  ): void {
    session.tasks.push(summary);
    appendTaskTranscript(
      session.session_id,
      taskBlock,
      this.pluginConfig.transcript_policy,
    );
    this.sessionDirty = true;
  }

  resolveWorkflowPath(nameOrPath: string): string | null {
    return resolveWorkflowRef(nameOrPath, this.config.cwd, this.pluginConfig);
  }

  listToolNames(): string[] {
    return toolRegistry.getDefinitions(this.config).map((d) => d.function.name);
  }

  listSpawnPresets(): Array<{ name: string; description: string; tools: string[] }> {
    return this.listSpawnCatalog().presets.map((p) => ({
      name: p.name,
      description: p.description,
      tools: p.tools,
    }));
  }

  listSpawnCatalog(): { presets: SpawnPresetEntry[]; orphans: OrphanAgentFile[] } {
    if (!toolRegistry.isInitialized()) {
      return { presets: [], orphans: [] };
    }
    const resolved = toolRegistry.getSpawnPresets();
    const presets = buildSpawnPresetEntries(
      this.config.cwd,
      this.pluginConfig,
      resolved,
    );
    const orphans = listOrphanAgentFiles(this.config.cwd, this.pluginConfig);
    return { presets, orphans };
  }

  listMcpTools(): Array<{
    apiName: string;
    serverName: string;
    toolName: string;
    description: string;
  }> {
    if (!toolRegistry.isInitialized()) return [];
    return toolRegistry.listMcpTools();
  }

  /** Background spawn jobs (workspace/jobs); emits `job_list` for listeners. */
  listBackgroundJobs(opts?: ListJobsOptions): SpawnJobMeta[] {
    const jobs = listSpawnJobs(opts);
    this.emit({
      type: 'job_list',
      jobs: jobs.map(toJobListEntry),
      running_count: countRunningJobs(jobs),
    });
    return jobs;
  }

  formatBackgroundJobList(opts?: ListJobsOptions): string {
    return formatJobList(opts);
  }

  /** Job detail text; emits `job_status` when found. */
  getBackgroundJobStatus(jobId: string, eventTail = 5): string | null {
    const detail = getJobStatusDetail(jobId, eventTail);
    if (!detail) return null;
    this.emit({
      type: 'job_status',
      job_id: detail.meta.job_id,
      status: detail.meta.status,
      preset: detail.meta.preset,
      stale: detail.stale,
      event_count: detail.event_total,
      has_result: detail.result !== null,
    });
    return formatJobStatus(jobId, eventTail);
  }

  getBackgroundJobEventsText(jobId: string, maxLines = 200): string | null {
    return formatJobEventsTail(jobId, maxLines);
  }

  countRunningBackgroundJobs(): number {
    return countRunningJobs(listSpawnJobs({ limit: 50 }));
  }

  listSkills(): Array<{ name: string; description: string }> {
    const dirs = this.pluginConfig.skills_dirs ?? [];
    const skills = discoverSkills(dirs);
    return [...skills.values()].map((s) => ({
      name: s.name,
      description: s.description,
    }));
  }

  isRunning(): boolean {
    return this.running;
  }

  abort(): void {
    if (!this.running) return;
    const sessionId = this.session?.session_id ?? 'unknown';
    this.emit({ type: 'run_stopping', session_id: sessionId });
    this.abortController.abort();
  }

  saveIfDirty(force = true): void {
    if (!this.session || !this.sessionDirty) return;
    if (!saveSessionThrottled(this.session, { force })) return;
    this.emit({
      type: 'session_saved',
      session_id: this.session.session_id,
      task_count: this.session.tasks.length,
    });
    this.sessionDirty = false;
  }

  /**
   * @param opts.skipArmedWorkflow — system auto_run: do not consume one-shot arm
   *   (also auto-detected for synthetic system_event prompts).
   */
  async runTask(
    prompt: string,
    opts?: { skipArmedWorkflow?: boolean },
  ): Promise<AgentResult> {
    if (this.running) {
      throw new Error('Agent is already running');
    }

    this.ensureSession();

    // System / auto_run paths must not consume the user's armed workflow.
    const skipArm =
      opts?.skipArmedWorkflow === true || isSyntheticSystemEventPrompt(prompt);

    if (skipArm) {
      return this.runSingleTask(prompt);
    }

    // One-shot arm: consume for this user task only.
    const workflowPath = this.armedWorkflowPath;
    this.armedWorkflowPath = null;

    if (workflowPath) {
      return this.runWorkflowTask(prompt, workflowPath);
    }
    return this.runSingleTask(prompt);
  }

  async runWorkflowTask(prompt: string, workflowPath: string): Promise<AgentResult> {
    if (this.running) {
      throw new Error('Agent is already running');
    }

    // One-shot: arm is only for the next task. Direct runWorkflowTask must not leave
    // runtime armed (TUI used to clear uiState only → next chat re-entered workflow).
    this.armedWorkflowPath = null;

    this.resetWebSearchTaskBudget();
    const session = this.ensureSession();
    // Spawn-style: keep parent transcript; roles run isolated inside runWorkflow.
    const priorMessages = [...session.current_messages];

    const resolved = this.resolveWorkflowPath(workflowPath) ?? workflowPath;
    if (!existsSync(resolved)) {
      throw new Error(`Workflow not found: ${workflowPath}`);
    }

    const checkpoint = buildWorkflowCheckpoint(resolved, this.config.cwd);

    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const wsMeta = workspacePromptRunStartMeta(this.beginRunWorkspacePrompt());
    this.emitRunStart(session.session_id, signal, wsMeta);
    setActiveActionSessionId(session.session_id);
    this.publishUserTaskToBridge(prompt);

    const restorePrior = (): void => {
      session.current_messages = [...priorMessages];
      this.sessionDirty = true;
      this.saveIfDirty();
    };

    try {
      this.emit(workflowConfirmStartEvent(checkpoint));
      const approved = await this.confirmWorkflowEntry(checkpoint, signal);
      this.emit(workflowConfirmEndEvent(checkpoint, approved, signal));
      if (!approved) {
        const aborted = signal.aborted;
        if (aborted) {
          restorePrior();
        }
        this.emit({
          type: 'run_end',
          reason: aborted ? 'aborted' : 'completed',
          message: aborted ? undefined : 'workflow cancelled',
        });
        return {
          text: aborted ? '[aborted]' : '[workflow cancelled]',
          messages: session.current_messages,
        };
      }

      const runConfig = this.buildRunConfig(signal);

      if (checkpoint.needsShell && !(await this.permissionGate.ensureShell(runConfig, 'workflow'))) {
        if (signal.aborted) {
          restorePrior();
          this.emit({ type: 'run_end', reason: 'aborted' });
          return { text: '[aborted]', messages: session.current_messages };
        }
        this.emit({
          type: 'run_end',
          reason: 'completed',
          message: 'workflow cancelled: shell not approved',
        });
        return {
          text: '[workflow cancelled: shell not approved]',
          messages: session.current_messages,
        };
      }
      if (checkpoint.needsWeb && !(await this.permissionGate.ensureWeb(runConfig, 'workflow'))) {
        if (signal.aborted) {
          restorePrior();
          this.emit({ type: 'run_end', reason: 'aborted' });
          return { text: '[aborted]', messages: session.current_messages };
        }
        this.emit({
          type: 'run_end',
          reason: 'completed',
          message: 'workflow cancelled: web not approved',
        });
        return {
          text: '[workflow cancelled: web not approved]',
          messages: session.current_messages,
        };
      }
      const wfResult = await runWorkflow({
        workflowPath: resolved,
        userTask: prompt,
        config: runConfig,
        session,
        stream: this.useStream,
        onStep: this.onStep,
        onTaskComplete: (taskSummary, taskBlock) => {
          this.handleTaskComplete(session, taskSummary, taskBlock);
        },
        onWorkflowStep: (info) => {
          this.emit({
            type: 'workflow_step',
            phase: info.phase,
            role: info.role,
            round: info.round,
          });
        },
      });

      const summary = formatWorkflowReturnSummary({
        workflowName: wfResult.workflow,
        userTask: prompt,
        resultText: wfResult.text,
        context: wfResult.context,
        handback: wfResult.handback,
      });

      // Restore parent history + append digest (do not keep multi-role transcripts).
      session.current_messages = mergeWorkflowResultIntoSessionMessages(
        priorMessages,
        prompt,
        summary,
      );
      this.sessionDirty = true;
      this.saveIfDirty();

      if (wfResult.handback) {
        this.emit({
          type: 'workflow_handback',
          workflow: wfResult.workflow,
          reason: wfResult.handback.reason,
          detail: wfResult.handback.detail,
          role: wfResult.handback.role,
          round: wfResult.handback.round,
        });
      }

      this.notifyWorkflowSettled({
        workflow: wfResult.workflow,
        workflowPath: resolved,
        sessionId: session.session_id,
        digest: summary,
        handbackReason: wfResult.handback?.reason,
      });

      this.emit({ type: 'run_end', reason: 'completed' });
      return { text: summary, messages: session.current_messages };
    } catch (err) {
      if (isAbortError(err)) {
        restorePrior();
        this.emit({ type: 'run_end', reason: 'aborted' });
        return { text: '[aborted]', messages: session.current_messages };
      }
      // Leave session consistent for retry / inspection.
      restorePrior();
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'run_end', reason: 'error', message });
      throw err;
    } finally {
      this.bridgeStepForwarder.dispose();
      await flushActionWrites().catch(() => undefined);
      await flushTranscriptWrites().catch(() => undefined);
      this.running = false;
      this.scheduleInboundDrain(session.session_id);
    }
  }

  private async runSingleTask(prompt: string): Promise<AgentResult> {
    const session = this.ensureSession();
    this.resetWebSearchTaskBudget();
    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const wsMeta = workspacePromptRunStartMeta(this.beginRunWorkspacePrompt());
    this.emitRunStart(session.session_id, signal, wsMeta);
    setActiveActionSessionId(session.session_id);
    // H1: user task as submitted (before handoff prefix injection into the model).
    this.publishUserTaskToBridge(prompt);

    const runConfig = this.buildRunConfig(signal);

    try {
      const priorMessages = [...session.current_messages];
      const answer = await runAgent({
        prompt: this.consumeHandoffPrompt(prompt),
        config: runConfig,
        session,
        sessionId: session.session_id,
        stream: this.useStream,
        signal,
        onStep: this.onStep,
        onTaskComplete: (taskSummary, taskBlock) => {
          this.handleTaskComplete(session, taskSummary, taskBlock);
        },
      });

      const stopDetail = parseAgentStopReason(answer.text);
      if (stopDetail) {
        session.current_messages = priorMessages;
        this.sessionDirty = true;
        this.saveIfDirty();

        const stopKind = classifyAgentStopReason(stopDetail);
        const hint =
          stopKind === 'loop_guard' || stopKind === 'turn_ceiling'
            ? ' Session context was rolled back. Send a new message to continue, or use /clear to reset in-flight context.'
            : ' Session context was rolled back.';
        this.emit({
          type: 'run_end',
          reason: 'completed',
          message: `${stopDetail}.${hint}`,
        });
        return answer;
      }

      session.current_messages = stripLoopGuardInjections(answer.messages);
      this.sessionDirty = true;
      this.saveIfDirty();

      const aborted = answer.text === '[aborted]';
      this.emit({ type: 'run_end', reason: aborted ? 'aborted' : 'completed' });
      return answer;
    } catch (err) {
      if (isAbortError(err)) {
        this.sessionDirty = true;
        this.saveIfDirty();
        this.emit({ type: 'run_end', reason: 'aborted' });
        return { text: '[aborted]', messages: session.current_messages };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'run_end', reason: 'error', message });
      throw err;
    } finally {
      this.bridgeStepForwarder.dispose();
      await flushActionWrites().catch(() => undefined);
      await flushTranscriptWrites().catch(() => undefined);
      this.running = false;
      this.scheduleInboundDrain(session.session_id);
    }
  }

  async shutdown(): Promise<void> {
    if (this.inboundDrainTimer) {
      clearTimeout(this.inboundDrainTimer);
      this.inboundDrainTimer = null;
    }
    setGlobalSystemEventHub(null);
    this.bridgeStepForwarder.dispose();
    await flushActionWrites().catch(() => undefined);
    await flushTranscriptWrites().catch(() => undefined);
    setActiveActionSessionId(undefined);
    await toolRegistry.shutdown();
  }

  private async confirmWorkflowEntry(
    info: WorkflowCheckpointInfo,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.workflowConfirmFn) {
      return this.workflowConfirmFn(info, signal);
    }
    console.error(formatWorkflowCheckpoint(info));
    console.error(
      'Workflow requires interactive confirmation (use TUI or set workflowConfirmFn).',
    );
    return false;
  }
}

/** CLI-style step printer (headless human output). */
export function printStepEvent(event: AgentStepEvent): void {
  switch (event.type) {
    case 'turn_start':
      console.log(`\n[turn ${event.turn}] ── LLM ──`);
      break;
    case 'token':
      process.stdout.write(event.delta);
      break;
    case 'llm_done': {
      const cachePart = event.cache ? ` cache=${JSON.stringify(event.cache)}` : '';
      console.log(
        `\n  finish=${event.finishReason ?? 'null'} tokens=${JSON.stringify(event.usage ?? {})}${cachePart}`,
      );
      break;
    }
    case 'llm_retry':
      console.log(`  ${formatLlmRetrySummary(event)}`);
      break;
    case 'llm_fallback':
      console.log(`  ${formatLlmFallbackSummary(event)}`);
      break;
    case 'compression':
      console.log(`  ${formatCompressionSummary(event)}`);
      break;
    case 'draft_discarded':
      console.log(`  ⊗ draft discarded (turn ${event.turn}, ${event.chars} chars)`);
      break;
    case 'loop_guard':
      console.log(
        `  🔄 loop_guard: ${event.action}${event.reason ? ` (${event.reason})` : ''}`,
      );
      break;
    case 'tool_plan':
      if (event.total >= 2) {
        console.log(`  ${formatToolPlanSummary(event)}`);
      }
      break;
    case 'tool_batch':
      if (event.parallel > 1) {
        console.log(`  ⚡ parallel batch: ${event.parallel}/${event.total} tools`);
      }
      break;
    case 'tool_call':
      console.log(`  → ${event.name}#${event.call_id}(${event.args})`);
      break;
    case 'turn_io':
      if (isActionIoMetricsEnabled()) {
        console.log(`  💾 ${formatTurnIoSummary(event)}`);
      }
      break;
    case 'tool_result': {
      const preview = event.preview ?? event.output;
      const shown =
        preview.length > 400 ? `${preview.slice(0, 400)}…` : preview;
      console.log(`  ← ${event.name}: ${shown.replace(/\n/g, '\\n')}`);
      break;
    }
    case 'final':
      console.log(`\n[done @ turn ${event.turn}]`);
      break;
  }
}