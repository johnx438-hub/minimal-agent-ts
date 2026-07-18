import type { AgentPluginConfig } from '../plugins/types.js';
import {
  resolveAgentProfile,
  type ResolvedAgentProfile,
} from '../agent-profile.js';
import type { ResolvedWorkflowRole, WorkflowRoleConfig } from './types.js';

export type ResolveWorkflowRoleOptions = {
  cwd: string;
  workflowPath: string;
  pluginConfig?: AgentPluginConfig;
};

export function resolveWorkflowRole(
  roleName: string,
  config: WorkflowRoleConfig,
  workflowPath: string,
  opts?: ResolveWorkflowRoleOptions,
): ResolvedWorkflowRole {
  const cwd = opts?.cwd ?? process.cwd();
  const plugin = opts?.pluginConfig;

  const profile: ResolvedAgentProfile = resolveAgentProfile(
    {
      name: roleName,
      preset: config.preset,
      prompt_file: config.prompt_file,
      prompt: config.prompt,
      tools: config.tools,
      max_turns: config.max_turns,
      api_profile: config.api_profile,
      model: config.model,
      keep_inline_turns: config.keep_inline_turns,
      pointerize_mode: config.pointerize_mode,
      shell: config.shell,
      description: config.description,
    },
    {
      cwd,
      workflowPath,
      spawnPresets: plugin?.spawn_presets,
      spawnPolicy: plugin?.spawn_policy,
      childKind: 'workflow',
    },
  );

  return {
    name: roleName,
    systemPrompt: profile.systemPrompt,
    tools: profile.tools,
    model: profile.model,
    api_profile: profile.api_profile,
    maxTurns: profile.maxTurns,
    keepInlineTurns: profile.keepInlineTurns,
    pointerizeMode: profile.pointerizeMode,
    shellPolicy: profile.shellPolicy,
  };
}
