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

    // Count issues from the one-line summary if it contains "Found N"
    const match = line.match(/Found (\d+)/);
    const count = match ? parseInt(match[1], 10) : 0;
    total += count;

    parts.push(`${emoji} **${line}**`);
    parts.push('');
  }

  parts.push('---');
  parts.push(`Total: ${total} issue${total !== 1 ? 's' : ''}`);
  parts.push('Full reports saved to:');
  parts.push('- `/workspace/code-review-bug.md`');
  parts.push('- `/workspace/code-review-security.md`');
  parts.push('- `/workspace/code-review-quality.md`');

  return parts.join('\n');
}

async function gitDiff(scope: string, cwd: string, extraArgs: string[] = []): Promise<string> {
  // Build args array — never pass scope directly into a shell string
  const args: string[] = ['diff', ...extraArgs];
  if (scope === 'staged') {
    args.push('--cached');
  } else if (scope && scope !== 'unstaged') {
    // Reject refs that look like git options to prevent argument injection
    if (scope.startsWith('-') && scope !== '--cached') {
      throw new Error(`invalid scope: "${scope}" looks like a git option. Use a ref name or file path.`);
    }
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
      // null means killed (timeout / signal)
      if (code === null || code > 1) {
        reject(new Error(`git diff exited ${code ?? 'via signal'}`));
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
      diff = await gitDiff(scope, config.cwd, ['--']);
    } else if (scope.startsWith('-') && scope !== '--cached') {
      return `error: invalid scope "${scope}" — refs cannot start with '-'. Use file paths like "src/..." or refs like "HEAD~3".`;
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
  return formatCombinedReport(results, scope);
}