import type { AgentConfig, ToolDefinition } from '../types.js';
import { getJobRegistry } from '../spawn/job-registry.js';
import { relativeJobFile } from '../spawn/job-paths.js';
import type { ResolvedSpawnPreset } from '../spawn/types.js';
import type { SpawnJobResult } from '../spawn/job-runner.js';

export function buildSpawnBackgroundDefinitions(
  presets: ResolvedSpawnPreset[],
): ToolDefinition[] {
  if (presets.length === 0) return [];

  const listing = presets
    .map((p) => `${p.name} (${p.description.slice(0, 60)})`)
    .join('; ');

  return [
    {
      type: 'function',
      function: {
        name: 'spawn_background',
        description:
          `Start a preset sub-agent in the background (non-blocking by default). ` +
          `Returns job_id + disk paths (meta/events/report). ` +
          `When the job finishes, the runtime notifies this main session (system notice; may auto-run a short synthetic turn if session_notify.auto_run is on) — ` +
          `do NOT busy-poll status or re-spawn to "check progress" unless the user asks or the job failed. ` +
          `Use wait=true only when you must block until completion in this turn. ` +
          `Presets: ${listing}`,
        parameters: {
          type: 'object',
          properties: {
            preset: {
              type: 'string',
              description: `Preset name. One of: ${presets.map((p) => p.name).join(', ')}`,
            },
            task: {
              type: 'string',
              description: 'Clear task description for the sub-agent',
            },
            output_hint: {
              type: 'string',
              description:
                'Optional expected report path (e.g. workspace/jobs/<job_id>/report.md)',
            },
            wait: {
              type: 'boolean',
              description:
                'When true, block until the job finishes and return result summary (default false). Prefer false: completion is pushed to the main session.',
            },
          },
          required: ['preset', 'task'],
        },
      },
    },
  ];
}

function resolvePreset(
  presetName: string,
  presets: ResolvedSpawnPreset[],
): ResolvedSpawnPreset | null {
  return (
    presets.find(
      (p) => p.name === presetName || p.name.toLowerCase() === presetName.toLowerCase(),
    ) ?? null
  );
}

export function formatSpawnBackgroundStarted(
  jobId: string,
  presetName: string,
): string {
  const relMeta = relativeJobFile(jobId, 'meta.json');
  const relEvents = relativeJobFile(jobId, 'events.jsonl');
  return [
    `spawn_background: started ${jobId} (${presetName})`,
    `status: ${relMeta}`,
    `events: ${relEvents}`,
    `notify: main session will receive a system notice when this job settles — continue other work; do not poll in a loop`,
    `Check (only if needed): npm run spawn:status -- ${jobId}`,
    `Kill:  npm run spawn:kill -- ${jobId}`,
  ].join('\n');
}

export function formatSpawnBackgroundWaitResult(
  jobId: string,
  result: SpawnJobResult,
): string {
  const relResult = relativeJobFile(jobId, 'result.json');
  const lines = [
    `spawn_background: ${result.status} ${jobId}`,
    `ok: ${result.ok}`,
    `summary: ${result.summaryLine}`,
    `result: ${relResult}`,
  ];
  if (result.reportPaths.length > 0) {
    lines.push(`reports: ${result.reportPaths.join(', ')}`);
  }
  if (result.error) {
    lines.push(`error: ${result.error}`);
  }
  return lines.join('\n');
}

export async function runSpawnBackgroundTool(
  name: string,
  args: Record<string, unknown>,
  config: AgentConfig,
  presets: ResolvedSpawnPreset[],
): Promise<string | null> {
  if (name !== 'spawn_background') return null;

  if ((config.spawnDepth ?? 0) > 0) {
    return 'error: spawn_background is not available inside a spawned sub-agent';
  }

  if (presets.length === 0) {
    return 'error: no spawn presets configured in agent.json';
  }

  const presetName = String(args.preset ?? '').trim();
  const task = String(args.task ?? '').trim();
  const outputHint = String(args.output_hint ?? '').trim();
  const wait = args.wait === true;

  if (!presetName) {
    return 'error: preset is required';
  }
  if (!task) {
    return 'error: task is required';
  }

  const preset = resolvePreset(presetName, presets);
  if (!preset) {
    return `error: unknown preset "${presetName}". Available: ${presets.map((p) => p.name).join(', ')}`;
  }

  const registry = getJobRegistry();
  const handle = registry.start({
    preset,
    task,
    parentConfig: config,
    outputPaths: outputHint ? [outputHint] : undefined,
  });

  if (wait) {
    const result = await handle.promise;
    return formatSpawnBackgroundWaitResult(handle.jobId, result);
  }

  return formatSpawnBackgroundStarted(handle.jobId, preset.name);
}