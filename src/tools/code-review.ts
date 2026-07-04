import { spawn } from 'node:child_process';
import type { AgentConfig, ToolDefinition } from '../types.js';
import { getJobRegistry } from '../spawn/job-registry.js';
import { relativeJobFile } from '../spawn/job-paths.js';
import type { ResolvedSpawnPreset } from '../spawn/types.js';

export const REVIEW_REPORT_PATHS: Record<string, string> = {
  'code-review-bug': 'workspace/code-review-bug.md',
  'code-review-security': 'workspace/code-review-security.md',
  'code-review-quality': 'workspace/code-review-quality.md',
};

export const FOCUS_MAP: Record<string, string> = {
  bug: 'code-review-bug',
  security: 'code-review-security',
  quality: 'code-review-quality',
};

export const DEFAULT_REVIEW_PRESETS = [
  'code-review-bug',
  'code-review-security',
  'code-review-quality',
] as const;

export const CODE_REVIEW_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'code_review',
      description:
        'Review code changes using concurrent sub-agents (bug, security, quality).' +
        ' Use scope="unstaged" for working tree, "HEAD~N" for recent commits, or a file path for single file.' +
        ' Set background=true to start non-blocking jobs (returns job_ids immediately).',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            description:
              'Git ref (e.g. "unstaged", "HEAD~3", "main") or file path (e.g. "src/tools/web-fetch.ts"). Default: "unstaged".',
          },
          before_action_id: {
            type: 'string',
            description:
              '(Not yet implemented — reserved for V2 single-file diff against historical action).',
          },
          focus: {
            type: 'string',
            description:
              'Optional comma-separated list of review dimensions: "bug,security,quality". Default: all three.',
          },
          background: {
            type: 'boolean',
            description:
              'When true, start review agents as background jobs and return immediately with job_ids (default false).',
          },
        },
        required: [],
      },
    },
  },
];

export function resolveRequestedReviewAgents(focus: string): string[] {
  if (!focus.trim()) return [...DEFAULT_REVIEW_PRESETS];
  return focus
    .split(',')
    .map((s) => {
      const trimmed = s.trim();
      return FOCUS_MAP[trimmed] ?? trimmed;
    })
    .filter(Boolean);
}

export function validateReviewAgents(requestedAgents: string[]): string | null {
  const validNames = new Set([...Object.values(FOCUS_MAP), ...DEFAULT_REVIEW_PRESETS]);
  const invalidFocus = requestedAgents.filter((a) => !validNames.has(a));
  if (invalidFocus.length === 0) return null;
  return `error: invalid focus values: ${invalidFocus.join(', ')}. Valid: bug, security, quality (or full preset names).`;
}

export function reportPathForReviewAgent(agent: string): string | undefined {
  return REVIEW_REPORT_PATHS[agent];
}

function formatCombinedReport(
  sections: { agent: string; text: string }[],
  scope: string,
): string {
  const parts: string[] = [`# Code Review: ${scope}\n`];

  let total = 0;
  for (const s of sections) {
    const line = s.text.trim();
    const emoji =
      s.agent === 'code-review-bug' ? '🐛' :
      s.agent === 'code-review-security' ? '🔐' : '📋';

    const match = line.match(/Found (\d+)/);
    const count = match ? parseInt(match[1], 10) : 0;
    total += count;

    parts.push(`${emoji} **${line}**`);
    parts.push('');
  }

  parts.push('---');
  parts.push(`Total: ${total} issue${total !== 1 ? 's' : ''}`);
  parts.push('Full reports saved to:');
  for (const agent of DEFAULT_REVIEW_PRESETS) {
    const path = REVIEW_REPORT_PATHS[agent];
    if (path) parts.push(`- \`${path}\``);
  }

  return parts.join('\n');
}

export function formatBackgroundReviewStarted(
  scope: string,
  jobs: Array<{ agent: string; jobId: string }>,
): string {
  const lines = [
    `code_review: started ${jobs.length} background job(s) (scope: ${scope})`,
    '',
    'AGENT                 JOB_ID                   STATUS',
  ];

  for (const { agent, jobId } of jobs) {
    lines.push(
      `${agent.padEnd(22)} ${jobId.padEnd(24)} ${relativeJobFile(jobId, 'meta.json')}`,
    );
  }

  lines.push('');
  lines.push('Check: npm run spawn:list');
  lines.push('Status: npm run spawn:status -- <job_id>');
  lines.push('Kill:  npm run spawn:kill -- <job_id>');
  lines.push('Reports when done:');
  for (const { agent } of jobs) {
    const path = reportPathForReviewAgent(agent);
    if (path) lines.push(`- ${path} (${agent})`);
  }

  return lines.join('\n');
}

async function gitDiff(scope: string, cwd: string, extraArgs: string[] = []): Promise<string> {
  const args: string[] = ['diff', ...extraArgs];
  if (scope === 'staged') {
    args.push('--cached');
  } else if (scope && scope !== 'unstaged') {
    if (scope.startsWith('-') && scope !== '--cached') {
      throw new Error(`invalid scope: "${scope}" looks like a git option. Use a ref name or file path.`);
    }
    args.push(scope);
  }

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, timeout: 10_000, windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.resume();
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new Error('git not found — is git installed?'));
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      const out = Buffer.concat(chunks).toString('utf8').trim();
      if (code === null || code > 1) {
        reject(new Error(`git diff exited ${code ?? 'via signal'}`));
      } else {
        resolve(out);
      }
    });
  });
}

type GitDiffFn = (scope: string, cwd: string, extraArgs?: string[]) => Promise<string>;

let gitDiffOverride: GitDiffFn | null = null;

export function setGitDiffForTests(fn: GitDiffFn | null): void {
  gitDiffOverride = fn;
}

async function resolveGitDiff(
  scope: string,
  cwd: string,
  extraArgs: string[] = [],
): Promise<string> {
  return (gitDiffOverride ?? gitDiff)(scope, cwd, extraArgs);
}

function buildDiffContextMessage(diff: string, scope: string): string {
  const header = `Review the following git diff (scope: ${scope}) for issues.`;
  const truncated =
    diff.length > 40_000
      ? diff.slice(0, 40_000) + '\n...(diff truncated at 40K chars)'
      : diff;
  return `${header}\n\n\`\`\`diff\n${truncated}\n\`\`\``;
}

async function loadReviewPresets(cwd: string, requestedAgents: string[]): Promise<ResolvedSpawnPreset[]> {
  const { loadSpawnPresets } = await import('../spawn/load-preset.js');
  const { loadAgentPluginConfig } = await import('../plugins/config-loader.js');
  const pluginConfig = loadAgentPluginConfig(cwd);
  const spawnConfigs = pluginConfig.spawn_presets ?? [];
  const spawnPolicy = pluginConfig.spawn_policy;
  const allPresets = loadSpawnPresets(cwd, spawnConfigs, spawnPolicy);
  return allPresets.filter((p) => requestedAgents.includes(p.name));
}

export function startBackgroundCodeReviewJobs(opts: {
  reviewPresets: ResolvedSpawnPreset[];
  diffMessage: string;
  config: AgentConfig;
}): Array<{ agent: string; jobId: string }> {
  const registry = getJobRegistry();
  const jobs: Array<{ agent: string; jobId: string }> = [];

  for (const preset of opts.reviewPresets) {
    const handle = registry.start({
      preset,
      task: opts.diffMessage,
      parentConfig: opts.config,
      outputPaths: reportPathForReviewAgent(preset.name)
        ? [reportPathForReviewAgent(preset.name)!]
        : undefined,
    });
    jobs.push({ agent: preset.name, jobId: handle.jobId });
  }

  return jobs;
}

export async function runSyncCodeReview(opts: {
  reviewPresets: ResolvedSpawnPreset[];
  diffMessage: string;
  config: AgentConfig;
  scope: string;
}): Promise<string> {
  const { resolveSpawnRunner } = await import('../spawn/job-runner.js');

  const results = await Promise.all(
    opts.reviewPresets.map(async (preset) => {
      try {
        const result = await resolveSpawnRunner()({
          preset,
          task: opts.diffMessage,
          parentConfig: opts.config,
        });
        return { agent: preset.name, text: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { agent: preset.name, text: `error: ${msg}` };
      }
    }),
  );

  return formatCombinedReport(results, opts.scope);
}

export async function runCodeReviewTool(
  _toolName: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  const scope = (args.scope as string)?.trim() || 'unstaged';
  const focus = (args.focus as string)?.trim() || '';
  const background = args.background === true;

  const requestedAgents = resolveRequestedReviewAgents(focus);
  const focusError = validateReviewAgents(requestedAgents);
  if (focusError) return focusError;

  let diff: string;
  try {
    if (scope.endsWith('.ts') || scope.startsWith('src/') || scope.startsWith('agents/')) {
      diff = await resolveGitDiff(scope, config.cwd, ['--']);
    } else if (scope.startsWith('-') && scope !== '--cached') {
      return `error: invalid scope "${scope}" — refs cannot start with '-'. Use file paths like "src/..." or refs like "HEAD~3".`;
    } else {
      diff = await resolveGitDiff(scope, config.cwd);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `error: failed to get git diff: ${msg}`;
  }

  if (!diff || diff === '') {
    return 'code_review: no changes to review (working tree clean)';
  }

  const diffMessage = buildDiffContextMessage(diff, scope);
  const reviewPresets = await loadReviewPresets(config.cwd, requestedAgents);

  if (reviewPresets.length === 0) {
    return 'error: no code review agent presets configured. Add code-review-bug, code-review-security, code-review-quality to spawn_presets in agent.json.';
  }

  if (background) {
    const jobs = startBackgroundCodeReviewJobs({
      reviewPresets,
      diffMessage,
      config,
    });
    return formatBackgroundReviewStarted(scope, jobs);
  }

  return runSyncCodeReview({
    reviewPresets,
    diffMessage,
    config,
    scope,
  });
}