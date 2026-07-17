import type { RunStartLlmMeta } from './events.js';
import {
  getCachedRemoteModelIds,
  isRemoteModelsEnabled,
  mergeStaticAndRemoteModels,
} from './llm-models-remote.js';
import type { SpawnJobLlmSnapshot } from './spawn/job-store.js';
import type {
  AgentPluginConfig,
  ApiProfileConfig,
  CacheMode,
  CachePolicyConfig,
  LlmWire,
} from './plugins/types.js';
import type { AgentConfig, LlmProfile } from './types.js';

/** Virtual profile backed by OPENAI_* / OPENROUTER_* / MODEL env vars. */
export const ENV_PROFILE_NAME = '__env__';

const DEFAULT_ENV_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_ENV_MODEL = 'gemini-2.0-flash';

const VALID_CACHE_MODES = new Set<CacheMode>([
  'off',
  'implicit',
  'openrouter_sticky',
  'prompt_cache_key',
  'anthropic_breakpoints',
]);

const VALID_WIRES = new Set<LlmWire>(['openai_chat']);

export type EnvSnapshot = Record<string, string | undefined>;

export interface ResolvedLlmBinding {
  profileName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  wire: LlmWire;
  cache?: CachePolicyConfig;
  extraBody?: Record<string, unknown>;
  displayName?: string;
  fallbackProfiles?: string[];
  reasoningMap?: Record<string, Record<string, unknown>>;
  /** Re-send assistant reasoning_content (Kimi / optional DeepSeek). */
  preserveReasoning?: boolean;
  /** Env var name used for apiKey (diagnostics / profile-switch UX). */
  apiKeyEnv?: string;
  /** Profile accepts multimodal image_url (read_file image attach). */
  supportsVision?: boolean;
  available: boolean;
  unavailableReason?: string;
}

export interface ResolveLlmBindingOptions {
  profileName?: string;
  model?: string;
  /** When set, used instead of process.env (tests). */
  env?: EnvSnapshot;
}

export class LlmProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmProfileError';
  }
}

function readEnv(name: string, env?: EnvSnapshot, fallback?: string): string | undefined {
  const source = env ?? process.env;
  const raw = source[name];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || fallback;
}

/** Strip trailing slashes; keep path prefix (e.g. …/v1 or …/paas/v4). */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function getEnvApiKey(env?: EnvSnapshot): string | undefined {
  return readEnv('OPENAI_API_KEY', env) ?? readEnv('OPENROUTER_API_KEY', env);
}

export function getEnvLlmDefaults(env?: EnvSnapshot): {
  baseUrl: string;
  model: string;
} {
  return {
    baseUrl: normalizeBaseUrl(readEnv('OPENAI_BASE_URL', env, DEFAULT_ENV_BASE_URL)!),
    model: readEnv('MODEL', env, DEFAULT_ENV_MODEL)!,
  };
}

function validateCachePolicy(name: string, cache: CachePolicyConfig | undefined): void {
  if (!cache) return;
  if (cache.mode && !VALID_CACHE_MODES.has(cache.mode)) {
    throw new LlmProfileError(
      `api_profiles.${name}.cache.mode invalid: ${String(cache.mode)}`,
    );
  }
}

function validateApiProfile(name: string, profile: ApiProfileConfig): void {
  if (!name.trim()) {
    throw new LlmProfileError('api_profiles key must be non-empty');
  }
  if (!profile.base_url?.trim()) {
    throw new LlmProfileError(`api_profiles.${name}.base_url is required`);
  }
  if (!profile.api_key_env?.trim()) {
    throw new LlmProfileError(`api_profiles.${name}.api_key_env is required`);
  }
  if (!profile.default_model?.trim()) {
    throw new LlmProfileError(`api_profiles.${name}.default_model is required`);
  }
  if (profile.wire && !VALID_WIRES.has(profile.wire)) {
    throw new LlmProfileError(`api_profiles.${name}.wire invalid: ${profile.wire}`);
  }
  validateCachePolicy(name, profile.cache);
}

/** Validate all configured profiles; no-op when api_profiles absent. */
export function validateApiProfiles(
  profiles: Record<string, ApiProfileConfig> | undefined,
): void {
  if (!profiles) return;
  for (const [name, profile] of Object.entries(profiles)) {
    validateApiProfile(name, profile);
  }
}

function resolveApiKey(apiKeyEnv: string, env?: EnvSnapshot): string | undefined {
  return readEnv(apiKeyEnv, env);
}

function resolveModel(
  opts: ResolveLlmBindingOptions,
  profile: ApiProfileConfig | null,
  env?: EnvSnapshot,
): string {
  const override = opts.model?.trim();
  if (override) return override;

  if (profile?.default_model?.trim()) {
    return profile.default_model.trim();
  }

  const fromEnv = readEnv('MODEL', env, DEFAULT_ENV_MODEL);
  if (fromEnv?.trim()) return fromEnv.trim();

  throw new LlmProfileError('LLM model could not be resolved (set model or default_model)');
}

/** Last 4 chars of a secret for UX (never log full keys). */
export function apiKeyFingerprint(apiKey: string | undefined): string {
  const k = apiKey?.trim() ?? '';
  if (k.length < 4) return '(none)';
  return `…${k.slice(-4)}`;
}

function buildEnvBinding(opts: ResolveLlmBindingOptions): ResolvedLlmBinding {
  const apiKey = getEnvApiKey(opts.env);
  const { baseUrl, model } = getEnvLlmDefaults(opts.env);
  const resolvedModel = resolveModel(opts, null, opts.env);

  if (!apiKey) {
    return {
      profileName: ENV_PROFILE_NAME,
      baseUrl,
      apiKey: '',
      model: resolvedModel,
      wire: 'openai_chat',
      cache: { mode: 'off' },
      displayName: 'Environment (MODEL/BASE_URL/API_KEY)',
      available: false,
      unavailableReason: 'Missing OPENAI_API_KEY or OPENROUTER_API_KEY',
    };
  }

  return {
    profileName: ENV_PROFILE_NAME,
    baseUrl,
    apiKey,
    model: resolvedModel,
    wire: 'openai_chat',
    cache: { mode: 'off' },
    displayName: 'Environment (MODEL/BASE_URL/API_KEY)',
    available: true,
  };
}

function buildNamedBinding(
  profileName: string,
  profile: ApiProfileConfig,
  opts: ResolveLlmBindingOptions,
): ResolvedLlmBinding {
  const apiKey = resolveApiKey(profile.api_key_env, opts.env);
  const model = resolveModel(opts, profile, opts.env);
  const available = Boolean(apiKey);
  const wire = profile.wire ?? 'openai_chat';

  return {
    profileName,
    baseUrl: normalizeBaseUrl(profile.base_url),
    apiKey: apiKey ?? '',
    model,
    wire,
    cache: profile.cache ?? { mode: 'off' },
    extraBody: profile.extra_body,
    displayName: profile.display_name ?? profileName,
    fallbackProfiles: profile.fallback_profiles,
    reasoningMap: profile.reasoning_map,
    preserveReasoning: profile.preserve_reasoning === true,
    apiKeyEnv: profile.api_key_env,
    supportsVision: profile.supports_vision === true,
    available,
    unavailableReason: available
      ? undefined
      : `Missing environment variable ${profile.api_key_env}`,
  };
}

function firstProfileName(profiles: Record<string, ApiProfileConfig>): string | undefined {
  const keys = Object.keys(profiles);
  return keys.length > 0 ? keys[0] : undefined;
}

/** Default profile name for main agent when opts.profileName omitted. */
export function resolveDefaultProfileName(
  pluginConfig: AgentPluginConfig,
  env?: EnvSnapshot,
): string {
  const profiles = pluginConfig.api_profiles;
  const explicit = pluginConfig.default_api_profile?.trim();

  if (explicit) {
    if (explicit === ENV_PROFILE_NAME) return ENV_PROFILE_NAME;
    if (!profiles?.[explicit]) {
      throw new LlmProfileError(`default_api_profile not found: ${explicit}`);
    }
    return explicit;
  }

  if (!profiles || Object.keys(profiles).length === 0) {
    return ENV_PROFILE_NAME;
  }

  const first = firstProfileName(profiles);
  if (first) return first;

  return ENV_PROFILE_NAME;
}

export function listProfileNames(
  pluginConfig: AgentPluginConfig,
  env?: EnvSnapshot,
): string[] {
  const names = Object.keys(pluginConfig.api_profiles ?? {});
  if (getEnvApiKey(env)) {
    if (!names.includes(ENV_PROFILE_NAME)) {
      names.push(ENV_PROFILE_NAME);
    }
  }
  return names.sort();
}

/** Static catalog + optional cached remote ids (G2-d); used by /model validation. */
export function knownModelsForProfile(
  pluginConfig: AgentPluginConfig,
  profileName: string,
  opts: { binding?: ResolvedLlmBinding; env?: EnvSnapshot } = {},
): string[] {
  const staticModels = listModelsForProfile(pluginConfig, profileName, opts.env);
  const binding = opts.binding;
  if (
    !binding ||
    !isRemoteModelsEnabled() ||
    binding.profileName !== profileName ||
    !binding.available
  ) {
    return staticModels;
  }
  const cached = getCachedRemoteModelIds(binding);
  if (!cached?.length) return staticModels;
  return mergeStaticAndRemoteModels(staticModels, cached);
}

export function validateModelForProfile(
  pluginConfig: AgentPluginConfig,
  profileName: string,
  model: string,
  opts: { binding?: ResolvedLlmBinding; env?: EnvSnapshot } = {},
): { ok: true } | { ok: false; message: string } {
  const trimmed = model.trim();
  const known = knownModelsForProfile(pluginConfig, profileName, opts);
  if (known.includes(trimmed)) {
    return { ok: true };
  }
  const remoteHint = isRemoteModelsEnabled()
    ? ' — use /model picker after remote list loads, or add to agent.json models'
    : '';
  return {
    ok: false,
    message: `error: model "${trimmed}" not in profile "${profileName}" catalog (${known.join(', ')})${remoteHint}`,
  };
}

export function listModelsForProfile(
  pluginConfig: AgentPluginConfig,
  profileName: string,
  env?: EnvSnapshot,
): string[] {
  if (profileName === ENV_PROFILE_NAME) {
    const model = resolveModel({}, null, env);
    return [model];
  }

  const profile = pluginConfig.api_profiles?.[profileName];
  if (!profile) {
    throw new LlmProfileError(`api profile not found: ${profileName}`);
  }

  if (profile.models && profile.models.length > 0) {
    return [...profile.models];
  }

  return [profile.default_model];
}

/**
 * Resolve a single LLM binding from agent.json api_profiles and/or env fallback.
 * Does not mutate pluginConfig.
 */
export function resolveLlmBinding(
  pluginConfig: AgentPluginConfig,
  opts: ResolveLlmBindingOptions = {},
): ResolvedLlmBinding {
  validateApiProfiles(pluginConfig.api_profiles);

  const profileName = opts.profileName?.trim() || resolveDefaultProfileName(pluginConfig, opts.env);

  if (profileName === ENV_PROFILE_NAME) {
    return buildEnvBinding(opts);
  }

  const profile = pluginConfig.api_profiles?.[profileName];
  if (!profile) {
    throw new LlmProfileError(`api profile not found: ${profileName}`);
  }

  return buildNamedBinding(profileName, profile, opts);
}

export function toLlmProfile(binding: ResolvedLlmBinding): LlmProfile {
  return {
    profileName: binding.profileName,
    baseUrl: binding.baseUrl,
    apiKey: binding.apiKey,
    model: binding.model,
    wire: binding.wire,
    cache: binding.cache,
    extraBody: binding.extraBody,
    displayName: binding.displayName,
    fallbackProfiles: binding.fallbackProfiles,
    reasoningMap: binding.reasoningMap,
    preserveReasoning: binding.preserveReasoning,
    apiKeyEnv: binding.apiKeyEnv,
    supportsVision: binding.supportsVision,
    available: binding.available,
    unavailableReason: binding.unavailableReason,
  };
}

/** Throws when binding is unavailable (missing API key, etc.). */
export function requireAvailableLlmBinding(binding: ResolvedLlmBinding): ResolvedLlmBinding {
  if (!binding.available) {
    throw new Error(
      binding.unavailableReason ??
        `LLM profile "${binding.profileName}" is unavailable`,
    );
  }
  return binding;
}

/** Flatten primary + fallback_profiles[] (deduped; missing names skipped with warn). */
export function resolveLlmBindingChain(
  pluginConfig: AgentPluginConfig,
  opts: ResolveLlmBindingOptions = {},
): ResolvedLlmBinding[] {
  const primary = resolveLlmBinding(pluginConfig, opts);
  const chain: ResolvedLlmBinding[] = [primary];
  const seen = new Set<string>([primary.profileName]);

  for (const raw of primary.fallbackProfiles ?? []) {
    const name = raw.trim();
    if (!name) continue;
    if (seen.has(name)) {
      console.warn(`llm: duplicate fallback profile "${name}", skipping`);
      continue;
    }
    seen.add(name);
    try {
      chain.push(
        resolveLlmBinding(pluginConfig, {
          profileName: name,
          env: opts.env,
        }),
      );
    } catch (err) {
      if (err instanceof LlmProfileError) {
        console.warn(`llm: fallback profile "${name}" not found, skipping`);
        continue;
      }
      throw err;
    }
  }

  return chain;
}

/** First available entry in a binding chain (G3 pre-flight / run_start effective profile). */
export function pickFirstAvailableBinding(
  chain: ResolvedLlmBinding[],
): ResolvedLlmBinding | undefined {
  return chain.find((b) => b.available);
}

/** Copy resolved binding onto AgentConfig (llm + legacy apiKey/baseUrl/model fields). */
export function applyLlmBindingToAgentConfig(
  config: AgentConfig,
  binding: ResolvedLlmBinding,
): void {
  config.llm = toLlmProfile(binding);
  config.apiKey = binding.apiKey;
  config.baseUrl = binding.baseUrl;
  config.model = binding.model;
}

/** Resolve binding for a spawn preset (inherits parent profile when preset omits api_profile). */
export function resolvePresetLlmBinding(
  pluginConfig: AgentPluginConfig,
  presetName: string,
  parent?: Pick<LlmProfile, 'profileName'> | null,
  opts: ResolveLlmBindingOptions = {},
): ResolvedLlmBinding {
  const preset = pluginConfig.spawn_presets?.find((p) => p.name === presetName);
  if (!preset) {
    throw new LlmProfileError(`spawn preset not found: ${presetName}`);
  }

  const profileName = preset.api_profile?.trim() || parent?.profileName;
  const model = opts.model?.trim() || preset.model?.trim();

  if (!profileName) {
    return resolveLlmBinding(pluginConfig, { ...opts, model });
  }

  return resolveLlmBinding(pluginConfig, {
    ...opts,
    profileName,
    model,
  });
}

/** Resolve binding for a workflow role (inherits parent profile when role omits api_profile). */
export function resolveWorkflowRoleLlmBinding(
  pluginConfig: AgentPluginConfig,
  role: { api_profile?: string; model?: string },
  parentLlm?: LlmProfile,
  opts: ResolveLlmBindingOptions = {},
): ResolvedLlmBinding {
  const profileName = role.api_profile?.trim() || parentLlm?.profileName;
  return resolveLlmBinding(pluginConfig, {
    ...opts,
    profileName,
    model: opts.model?.trim() || role.model?.trim(),
  });
}

/** Host only — safe for run_start / logs (no path, no key). */
export function llmBaseUrlHost(baseUrl: string): string | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed || !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return undefined;
  }
  try {
    const host = new URL(trimmed).host;
    return host || undefined;
  } catch {
    return undefined;
  }
}

function jobLlmSnapshotFromBinding(binding: ResolvedLlmBinding): SpawnJobLlmSnapshot {
  const snap: SpawnJobLlmSnapshot = {
    api_profile: binding.profileName,
    model: binding.model,
    cache_mode: binding.cache?.mode ?? 'off',
  };
  if (binding.baseUrl.trim()) {
    snap.llm_base_url = normalizeBaseUrl(binding.baseUrl);
  }
  return snap;
}

function jobLlmSnapshotFromProfile(llm: LlmProfile): SpawnJobLlmSnapshot {
  const snap: SpawnJobLlmSnapshot = {
    api_profile: llm.profileName,
    model: llm.model,
    cache_mode: llm.cache?.mode ?? 'off',
  };
  if (llm.baseUrl.trim()) {
    snap.llm_base_url = normalizeBaseUrl(llm.baseUrl);
  }
  return snap;
}

/**
 * Resolve preset/parent LLM binding for job meta.json (G2-b).
 * Matches spawn runner preset binding when preset exists in agent.json.
 */
export function buildJobLlmMeta(
  parentConfig: AgentConfig,
  presetName: string,
  opts: ResolveLlmBindingOptions = {},
): SpawnJobLlmSnapshot | undefined {
  const pluginConfig = parentConfig.llmPluginConfig;
  const parentLlm = parentConfig.llm;

  if (pluginConfig?.spawn_presets?.some((p) => p.name === presetName)) {
    const binding = resolvePresetLlmBinding(
      pluginConfig,
      presetName,
      parentLlm ?? null,
      opts,
    );
    return jobLlmSnapshotFromBinding(binding);
  }

  if (parentLlm) {
    return jobLlmSnapshotFromProfile(parentLlm);
  }

  const model = parentConfig.model?.trim();
  if (!model) return undefined;

  const snap: SpawnJobLlmSnapshot = {
    api_profile: '__env__',
    model,
    cache_mode: 'off',
  };
  if (parentConfig.baseUrl?.trim()) {
    snap.llm_base_url = normalizeBaseUrl(parentConfig.baseUrl);
  }
  return snap;
}

export interface RunStartLlmFallbackMeta {
  enabled: boolean;
  disabledReason?: 'FALLBACK=0' | 'explicit_model';
}

/** Build run_start.llm from the same LlmProfile used by buildRunConfig. */
export function buildRunStartLlmMeta(
  llm: LlmProfile | undefined,
  sessionReasoningLevel?: string,
  fallback?: RunStartLlmFallbackMeta,
): RunStartLlmMeta | undefined {
  if (!llm) return undefined;
  const host = llmBaseUrlHost(llm.baseUrl);
  const meta: RunStartLlmMeta = {
    profile: llm.profileName,
    model: llm.model,
    cache_mode: llm.cache?.mode ?? 'off',
  };
  if (host) meta.base_url_host = host;
  const reasoning = sessionReasoningLevel?.trim();
  if (reasoning) meta.reasoning = reasoning;
  if (fallback && !fallback.enabled) {
    meta.profile_fallback_enabled = false;
    if (fallback.disabledReason) {
      meta.profile_fallback_disabled_reason = fallback.disabledReason;
    }
  }
  return meta;
}