import { spawn } from 'node:child_process';
import type { AgentConfig, ToolDefinition } from '../types.js';

export const CODE_REVIEW_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'code_review',
      description:
        'Review code changes using concurrent sub-agents (bug, security, quality).' +
        ' Use scope="unstaged" for working tree, "HEAD~N" for recent commits, or a file path for single file.',
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
        },
        required: [],
      },
    },
  },
];

function dedupIssues(
  sections: { agent: string; text: string }[],
): string {
  // Simple dedup: keep per-agent sections, just add a header.
  // Per-line + per-category dedup would need NLP, skip for V1.
  const parts: string[] = ['# Code Review Report\n'];

  let total = 0;
  for (const s of sections) {
    const lines = s.text.trim().split('\n').filter((l) => l.trim());
    const issueCount = lines.filter(
      (l) => l.startsWith('🔴') || l.startsWith('🟠') || l.startsWith('🔵'),
    ).length;
    total += issueCount;

    const agentLabel =
      s.agent === 'code-review-bug'
        ? '🐛 Bug Detection'
        : s.agent === 'code-review-security'
          ? '🔐 Security'
          : '📋 Code Quality';

    parts.push(`## ${agentLabel} (${issueCount} issue${issueCount !== 1 ? 's' : ''})`);
    parts.push('');
    parts.push(s.text.trim());
    parts.push('');
  }

  parts.push('---');
  parts.push(`Total: ${total} issue${total !== 1 ? 's' : ''}`);
  parts.push(
    'Reviewed by: code-review-bug, code-review-security, code-review-quality',
  );

  return parts.join('\n');
}

async function gitDiff(scope: string, cwd: string): Promise<string> {
  // Build args array — never pass scope directly into a shell string
  const args: string[] = ['diff'];
  if (scope === 'staged') {
    args.push('--cached');
  } else if (scope && scope !== 'unstaged') {
    // scope is a ref like HEAD~3, a file path, etc.
    args.push(scope);
  }

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, timeout: 10_000, windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.resume(); // ignore stderr (git diff outputs to stdout only)
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new Error('git not found — is git installed?'));
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      const out = Buffer.concat(chunks).toString('utf8').trim();
      // git diff exits 0 for changes, 1 for no changes, >1 for error
      if (code !== null && code > 1) {
        reject(new Error(`git diff exited ${code}`));
      } else {
        resolve(out);
      }
    });
  });
}

function buildDiffContextMessage(diff: string, scope: string): string {
  const header = `Review the following git diff (scope: ${scope}) for issues.`;
  const truncated =
    diff.length > 40_000
      ? diff.slice(0, 40_000) + '\n...(diff truncated at 40K chars)'
      : diff;
  return `${header}\n\n\`\`\`diff\n${truncated}\n\`\`\``;
}

export async function runCodeReviewTool(
  _toolName: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  const scope = (args.scope as string)?.trim() || 'unstaged';
  const focus = (args.focus as string)?.trim() || '';

  const FOCUS_MAP: Record<string, string> = {
    bug: 'code-review-bug',
    security: 'code-review-security',
    quality: 'code-review-quality',
  };

  // Accept both short labels (bug) and full preset names (code-review-bug)
  const defaultPresets = ['code-review-bug', 'code-review-security', 'code-review-quality'];
  const requestedAgents = focus
    ? focus.split(',').map((s) => {
        const trimmed = s.trim();
        return FOCUS_MAP[trimmed] ?? trimmed;
      }).filter(Boolean)
    : defaultPresets;

  const validNames = new Set([...Object.values(FOCUS_MAP), ...defaultPresets]);
  const invalidFocus = requestedAgents.filter((a) => !validNames.has(a));
  if (invalidFocus.length > 0) {
    return `error: invalid focus values: ${invalidFocus.join(', ')}. Valid: bug, security, quality (or full preset names).`;
  }

  // 1. Get diff
  let diff: string;
  try {
    if (scope.endsWith('.ts') || scope.startsWith('src/') || scope.startsWith('agents/')) {
      diff = await gitDiff(`-- "${scope}"`, config.cwd);
    } else {
      diff = await gitDiff(scope, config.cwd);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `error: failed to get git diff: ${msg}`;
  }

  if (!diff || diff === '') {
    return 'code_review: no changes to review (working tree clean)';
  }

  const diffMessage = buildDiffContextMessage(diff, scope);

  // 2. Concurrent spawn review agents
  const { runSpawnAgent } = await import('../spawn/runner.js');
  const { loadSpawnPresets } = await import('../spawn/load-preset.js');

  const { loadAgentPluginConfig } = await import('../plugins/config-loader.js');
  const pluginConfig = loadAgentPluginConfig(config.cwd);
  const spawnConfigs = pluginConfig.spawn_presets ?? [];
  const spawnPolicy = pluginConfig.spawn_policy;
  const allPresets = loadSpawnPresets(config.cwd, spawnConfigs, spawnPolicy);
  const reviewPresets = allPresets.filter((p) => requestedAgents.includes(p.name));

  if (reviewPresets.length === 0) {
    return 'error: no code review agent presets configured. Add code-review-bug, code-review-security, code-review-quality to spawn_presets in agent.json.';
  }

  const results = await Promise.all(
    reviewPresets.map(async (preset) => {
      try {
        const result = await runSpawnAgent({
          preset,
          task: diffMessage,
          parentConfig: config,
        });
        return { agent: preset.name, text: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { agent: preset.name, text: `error: ${msg}` };
      }
    }),
  );

  // 3. Format report
  return dedupIssues(results);
}