import { resolve } from 'node:path';
import 'dotenv/config';  // Load .env file

import { loadAgentPluginConfig } from './plugins/config-loader.js';
import { runAgent } from './agent.js';
import { createSession, loadSession, saveSession } from './session.js';
import { previewPolicyFromPointerize } from './action-preview.js';
import { parseLoopGuardMode } from './loop-guard.js';
import { ensureToolRegistry, toolRegistry } from './tools/registry.js';
import type { AgentConfig } from './types.js';

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || fallback;
}

function parseArgs(argv: string[]): {
  prompt: string;
  cwd: string;
  resumeSessionId?: string;
  listTools: boolean;
  loadSkills: string[];
  allowShell: boolean;
} {
  let listTools = false;
  const loadSkills: string[] = [];
  let allowShell = false;

  const shellIdx = argv.indexOf('--allow-shell');
  if (shellIdx >= 0) {
    allowShell = true;
    argv = [...argv.slice(0, shellIdx), ...argv.slice(shellIdx + 1)];
  }

  const listIdx = argv.indexOf('--list-tools');
  if (listIdx >= 0) {
    listTools = true;
    argv = [...argv.slice(0, listIdx), ...argv.slice(listIdx + 1)];
  }

  const skillsIdx = argv.indexOf('--load-skills');
  if (skillsIdx >= 0 && argv[skillsIdx + 1]) {
    loadSkills.push(
      ...argv[skillsIdx + 1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    argv = [...argv.slice(0, skillsIdx), ...argv.slice(skillsIdx + 2)];
  }

  // Check for --resume <session_id>
  let resumeSessionId: string | undefined;
  const resumeIdx = argv.indexOf('--resume');
  if (resumeIdx >= 0 && argv[resumeIdx + 1]) {
    resumeSessionId = argv[resumeIdx + 1];
    // Remove --resume and its arg from argv for further parsing
    argv = [...argv.slice(0, resumeIdx), ...argv.slice(resumeIdx + 2)];
  }

  const dash = argv.indexOf('--');
  const prompt =
    dash >= 0 ? argv.slice(dash + 1).join(' ').trim() : argv.join(' ').trim();

  let cwd = process.cwd();
  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx >= 0 && argv[cwdIdx + 1]) {
    cwd = resolve(argv[cwdIdx + 1]);
  }

  if (!prompt && !listTools) {
    console.error('Usage:');
    console.error('  OPENROUTER_API_KEY=... npm start -- "你的任务"');
    console.error('  npm start -- --cwd /path/to/project "你的任务"');
    console.error('  npm start -- --resume <session_id> "继续上次的工作"');
    console.error('  npm start -- --list-tools');
    console.error('  npm start -- --load-skills context-design "任务"');
    console.error('');
    console.error('Optional env:');
    console.error('  OPENAI_BASE_URL  (default: Gemini OpenAI-compatible URL)');
    console.error('  MODEL            (default: gemini-2.0-flash)');
    console.error('  MAX_TURNS        (default: 0 = unlimited; loop guard + hard ceiling)');
    console.error('  LOOP_HARD_CEILING (default: 200)');
    console.error('  LOOP_GUARD       inject | terminate | off (default: inject)');
    console.error('  --allow-shell    enable run_shell tool (or ALLOW_SHELL=1)');
    console.error('');
    console.error('Plugins: agent.json (builtin_tools, mcp_servers, skills_dirs)');
    process.exit(1);
  }

  return { prompt, cwd, resumeSessionId, listTools, loadSkills, allowShell };
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const { prompt, cwd, resumeSessionId, listTools, loadSkills, allowShell: cliAllowShell } =
    parseArgs(rawArgv);

  const apiKey = env('OPENAI_API_KEY') ?? env('OPENROUTER_API_KEY');
  if (!apiKey) {
    console.error('Missing OPENAI_API_KEY or OPENROUTER_API_KEY');
    process.exit(1);
  }

  const useStream = env('STREAM', '1') !== '0';

  const loopGuardMode = parseLoopGuardMode(env('LOOP_GUARD', 'inject'));

  const pluginConfig = loadAgentPluginConfig(cwd);
  if (loadSkills.length > 0) {
    pluginConfig.loaded_skills = [
      ...new Set([...(pluginConfig.loaded_skills ?? []), ...loadSkills]),
    ];
  }

  const keepInlineTurns = pluginConfig.pointerize_policy?.keep_inline_turns ?? 2;
  const recallAutoFullMaxChars = pluginConfig.recall_policy?.auto_full_max_chars ?? 24_000;
  const previewPolicy = previewPolicyFromPointerize(pluginConfig.pointerize_policy);

  const config: AgentConfig = {
    apiKey,
    baseUrl: env('OPENAI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai')!,
    model: env('MODEL', 'gemini-2.0-flash')!,
    maxTurns: Number(env('MAX_TURNS', '0')),
    cwd,
    allowShell: cliAllowShell || env('ALLOW_SHELL') === '1',
    loopGuard: {
      enabled: loopGuardMode !== 'off',
      mode: loopGuardMode,
      hardCeiling: Number(env('LOOP_HARD_CEILING', '200')),
    },
    keepInlineTurns,
    recallAutoFullMaxChars,
    previewPolicy,
  };

  await ensureToolRegistry(cwd, pluginConfig);

  if (listTools) {
    const defs = toolRegistry.getDefinitions(config);
    console.log('Available tools:');
    for (const def of defs) {
      console.log(`  - ${def.function.name}`);
    }
    console.log(`Skills: ${toolRegistry.listSkillNames().join(', ') || '(none)'}`);
    if (!config.allowShell) {
      console.log('Note: run_shell hidden until --allow-shell or ALLOW_SHELL=1');
    }
    await toolRegistry.shutdown();
    return;
  }

  const mcpCount = defsCountMcp(toolRegistry.getDefinitions(config));
  if (mcpCount > 0) {
    console.log(`mcp: ${mcpCount} tools loaded`);
  }
  const skillNames = toolRegistry.listSkillNames();
  if (skillNames.length > 0) {
    console.log(`skills: ${skillNames.join(', ')}`);
  }

  // Session management: load existing or create new
  let session;
  if (resumeSessionId) {
    session = loadSession(resumeSessionId);
    if (!session) {
      console.error(`Session not found: ${resumeSessionId}`);
      process.exit(1);
    }
    console.log(`Resumed session: ${session.session_id} (${session.tasks.length} previous tasks)`);
  } else {
    session = createSession(env('USER_ID') ?? 'user_default');
    console.log(`New session: ${session.session_id}`);
  }

  console.log('─'.repeat(60));
  console.log('minimal-agent-ts');
  console.log(`model: ${config.model}`);
  console.log(`cwd:   ${config.cwd}`);
  console.log(`shell: ${config.allowShell ? 'on' : 'off (use --allow-shell)'}`);
  console.log(`session: ${session.session_id}`);
  console.log('─'.repeat(60));
  console.log(`task: ${prompt}\n`);

  const answer = await runAgent({
    prompt,
    config,
    session,
    sessionId: session.session_id,
    stream: useStream,
    onStep(event) {
      switch (event.type) {
        case 'turn_start':
          console.log(`\n[turn ${event.turn}] ── LLM ──`);
          break;
        case 'token':
          process.stdout.write(event.delta);
          break;
        case 'llm_done':
          console.log(
            `\n  finish=${event.finishReason ?? 'null'} tokens=${JSON.stringify(event.usage ?? {})}`,
          );
          break;
        case 'compression':
          console.log(
            event.pruned
              ? `  📦 pruned ${event.pruned} messages (compacted_at)`
              : `  📦 compression event: summaries + notice + replay user task`,
          );
          break;
        case 'loop_guard':
          console.log(
            `  🔄 loop_guard: ${event.action}${event.reason ? ` (${event.reason})` : ''}`,
          );
          break;
        case 'tool_batch':
          if (event.parallel > 1) {
            console.log(`  ⚡ parallel batch: ${event.parallel}/${event.total} tools`);
          }
          break;
        case 'tool_call':
          console.log(`  → ${event.name}(${event.args})`);
          break;
        case 'tool_result': {
          const preview =
            event.output.length > 400
              ? `${event.output.slice(0, 400)}…`
              : event.output;
          console.log(`  ← ${event.name}: ${preview.replace(/\n/g, '\\n')}`);
          break;
        }
        case 'final':
          console.log(`\n[done @ turn ${event.turn}]`);
          break;
      }
    },
    onTaskComplete(taskSummary) {
      // Save task summary to session
      session.tasks.push(taskSummary);
      saveSession(session);
      console.log(`\n💾 Task saved: ${taskSummary.task_id}`);
    },
  });

  // Update session with final messages
  session.current_messages = answer.messages;
  saveSession(session);

  console.log('\n' + '─'.repeat(60));
  if (!useStream) {
    console.log(answer.text);
  }
  console.log('─'.repeat(60));
}

function defsCountMcp(defs: { function: { name: string } }[]): number {
  return defs.filter((d) => d.function.name.startsWith('mcp_')).length;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => {
    void toolRegistry.shutdown();
  });