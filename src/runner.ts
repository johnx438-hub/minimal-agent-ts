import { existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';

import { loadAgentPluginConfig } from './plugins/config-loader.js';
import { discoverSkills } from './plugins/skills.js';
import { runAgent, type AgentResult } from './agent.js';
import type { AgentStepEvent } from './events.js';
import { previewPolicyFromPointerize } from './action-preview.js';
import {
  emitJsonEvent,
  formatLlmRetrySummary,
  formatToolPlanSummary,
  isAbortError,
  type RuntimeEvent,
} from './events.js';
import { parseLoopGuardMode, stripLoopGuardInjections } from './loop-guard.js';
import { classifyAgentStopReason, parseAgentStopReason } from './workflow/handback.js';
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
} from './session.js';
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
import { listWorkflowMetaForCwd } from './workflow/catalog.js';
import { runWorkflow } from './workflow/runner.js';
import { resetZvecCollection } from './action-index.js';
import { appendTaskTranscript } from './session-transcript.js';
import { flushTranscriptWrites } from './session-transcript-queue.js';
import {
  configureActionWriteQueue,
  flushActionWrites,
  setActiveActionSessionId,
} from './action-write-queue.js';
import {
  configureActionIndexQueue,
  flushActionIndex,
} from './action-index-queue.js';
import { formatTurnIoSummary, isActionIoMetricsEnabled } from './action-io-metrics.js';
import {
  createP0Collector,
  isP0TelemetryEnabled,
  type P0TelemetryCollector,
} from './p0-telemetry.js';
import type { TaskBlock } from './task-tracker.js';
import { setWorkspaceRoot } from './workspace.js';
import {
  loadWorkspacePromptBundle,
  workspacePromptRunStartMeta,
} from './agent-prompt.js';
import {
  applyLlmBindingToAgentConfig,
  buildRunStartLlmMeta,
  listModelsForProfile,
  listProfileNames,
  requireAvailableLlmBinding,
  resolveLlmBinding,
  type ResolvedLlmBinding,
} from './llm-profiles.js';

export interface SessionLlmOverride {
  profileName?: string;
  model?: string;
}

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

  const llmBinding = requireAvailableLlmBinding(resolveLlmBinding(pluginConfig));

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

  applyLlmBindingToAgentConfig(config, llmBinding);

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
  readonly permissionGate = new PermissionGate();
  private workflowConfirmFn?: WorkflowConfirmFn;
  private pendingHandoffPrefix: string | null = null;
  private runWorkspacePrompt: WorkspacePromptBundle | null = null;
  private readonly p0Collector: P0TelemetryCollector | null;
  private sessionLlmOverride: SessionLlmOverride = {};

  constructor(opts: AgentRuntimeOptions) {
    setWorkspaceRoot(opts.cwd);

    const built = buildAgentConfig({
      cwd: opts.cwd,
      loadSkills: opts.loadSkills,
      allowShell: opts.tuiMode
        ? opts.allowShell !== false
        : (opts.allowShell ?? false) || env('ALLOW_SHELL') === '1',
      allowWeb: (opts.allowWeb ?? false) || env('ALLOW_WEB') === '1',
    });
    this.config = built.config;
    this.pluginConfig = built.pluginConfig;
    this.jsonEvents = opts.jsonEvents ?? false;
    this.useStream = env('STREAM', '1') !== '0';
    this.p0Collector = isP0TelemetryEnabled() ? createP0Collector(opts.cwd) : null;
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

    configureActionIndexQueue({
      onFlush: (info) => {
        this.emit({
          type: 'index_flush',
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
      this.session = loaded;
    } else if (opts.resumeLatest) {
      const latest = getLatestSession(env('USER_ID'));
      if (!latest) {
        if (!deferSession) {
          this.session = createSession(env('USER_ID') ?? 'user_default');
          this.sessionDirty = true;
        }
      } else {
        const loaded = loadSession(latest.session_id);
        if (!loaded) {
          throw new Error(`Session not found: ${latest.session_id}`);
        }
        this.session = loaded;
      }
    } else if (!deferSession) {
      this.session = createSession(env('USER_ID') ?? 'user_default');
      this.sessionDirty = true;
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
      this.session = createSession(env('USER_ID') ?? 'user_default');
      this.sessionDirty = true;
    }
    return this.session;
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

  private emit(event: RuntimeEvent): void {
    this.p0Collector?.onEvent(event);
    if (this.jsonEvents) {
      emitJsonEvent(event);
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private onStep = (event: AgentStepEvent): void => {
    this.emit(event);
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
    const { profileName, model } = this.sessionLlmOverride;
    return (profileName?.trim() ?? '') !== '' || (model?.trim() ?? '') !== '';
  }

  getSessionLlmOverride(): Readonly<SessionLlmOverride> {
    return { ...this.sessionLlmOverride };
  }

  private clearSessionLlmOverride(): void {
    this.sessionLlmOverride = {};
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
    return `llm:${binding.profileName}/${binding.model}${star}`;
  }

  formatSessionLlmStatus(): string {
    const binding = this.resolveRunLlmBinding();
    const tag = `${binding.profileName}/${binding.model}`;
    const override = this.hasSessionLlmOverride() ? ' (session override)' : '';
    const cache =
      binding.cache?.mode && binding.cache.mode !== 'off'
        ? ` cache=${binding.cache.mode}`
        : '';
    return `llm: ${tag}${override}${cache} — main agent only; spawn jobs use preset binding`;
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
      this.sessionLlmOverride = {
        profileName: trimmed,
        ...(preservedModel ? { model: preservedModel } : {}),
      };
      const models = listModelsForProfile(this.pluginConfig, trimmed);
      const hint =
        models.length > 1
          ? ` Models: ${models.join(', ')} (use /model)`
          : '';
      const displayModel = preservedModel ?? binding.model;
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
    delete this.sessionLlmOverride.model;
    if (!(this.sessionLlmOverride.profileName?.trim())) {
      this.clearSessionLlmOverride();
    }
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
    };
    applyLlmBindingToAgentConfig(runConfig, this.resolveRunLlmBinding());
    return runConfig;
  }

  /** run_start.llm uses the same binding as the upcoming agent run (G2-a). */
  private emitRunStart(
    sessionId: string,
    signal: AbortSignal,
    wsMeta: ReturnType<typeof workspacePromptRunStartMeta>,
  ): void {
    const llmMeta = buildRunStartLlmMeta(this.buildRunConfig(signal).llm);
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

  resumeSession(id: string): boolean {
    const loaded = loadSession(id);
    if (!loaded) return false;
    this.session = loaded;
    this.sessionDirty = false;
    this.clearSessionLlmOverride();
    return true;
  }

  newSession(): void {
    this.session = createSession(env('USER_ID') ?? 'user_default');
    this.sessionDirty = true;
    this.clearSessionLlmOverride();
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

  async setCwd(path: string): Promise<void> {
    const resolved = resolve(path);
    setWorkspaceRoot(resolved);
    this.config.cwd = resolved;
    this.pluginConfig = loadAgentPluginConfig(resolved);
    resetZvecCollection();
    await reinitializeToolRegistry(resolved, this.pluginConfig);
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
    return listWorkflowMetaForCwd(this.config.cwd);
  }

  getSessionOverview(sessionId: string): SessionOverview | null {
    const session = loadSession(sessionId);
    if (!session) return null;
    return buildSessionOverview(session);
  }

  /** Session for /log; defaults to active session. */
  resolveLogSession(sessionId?: string): SessionFile | null {
    if (sessionId) return loadSession(sessionId);
    return this.session;
  }

  /** Alias for /history — same resolution as /log. */
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
    let path = nameOrPath;
    if (!path.includes('/') && !path.endsWith('.json')) {
      path = `workflows/${path}.json`;
    }
    const resolved = isAbsolute(path) ? path : resolve(this.config.cwd, path);
    if (!existsSync(resolved)) return null;
    return resolved;
  }

  listToolNames(): string[] {
    return toolRegistry.getDefinitions(this.config).map((d) => d.function.name);
  }

  listSpawnPresets(): Array<{ name: string; description: string; tools: string[] }> {
    if (!toolRegistry.isInitialized()) return [];
    return toolRegistry.getSpawnPresets().map((p) => ({
      name: p.name,
      description: p.description,
      tools: p.tools,
    }));
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

  async runTask(prompt: string): Promise<AgentResult> {
    if (this.running) {
      throw new Error('Agent is already running');
    }

    this.ensureSession();

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

    const session = this.ensureSession();

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

    try {
      this.emit(workflowConfirmStartEvent(checkpoint));
      const approved = await this.confirmWorkflowEntry(checkpoint, signal);
      this.emit(workflowConfirmEndEvent(checkpoint, approved, signal));
      if (!approved) {
        const aborted = signal.aborted;
        if (aborted) {
          this.sessionDirty = true;
          this.saveIfDirty();
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
          this.sessionDirty = true;
          this.saveIfDirty();
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
          this.sessionDirty = true;
          this.saveIfDirty();
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

      session.current_messages = [];
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

      this.emit({ type: 'run_end', reason: 'completed' });
      return { text: wfResult.text, messages: [] };
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
      await flushActionWrites().catch(() => undefined);
      await flushActionIndex().catch(() => undefined);
      await flushTranscriptWrites().catch(() => undefined);
      this.running = false;
    }
  }

  private async runSingleTask(prompt: string): Promise<AgentResult> {
    const session = this.ensureSession();
    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const wsMeta = workspacePromptRunStartMeta(this.beginRunWorkspacePrompt());
    this.emitRunStart(session.session_id, signal, wsMeta);
    setActiveActionSessionId(session.session_id);

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
      await flushActionWrites().catch(() => undefined);
      await flushActionIndex().catch(() => undefined);
      await flushTranscriptWrites().catch(() => undefined);
      this.running = false;
    }
  }

  async shutdown(): Promise<void> {
    await flushActionWrites().catch(() => undefined);
    await flushActionIndex().catch(() => undefined);
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
    case 'compression':
      console.log(
        event.pruned
          ? `  📦 pruned ${event.pruned} messages (compacted_at)`
          : event.pointer_compacted
            ? `  📦 compacted ${event.pointer_compacted} pointer cards (secondary)`
            : `  📦 compression event: summaries + notice + replay user task`,
      );
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