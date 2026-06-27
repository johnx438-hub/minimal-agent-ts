import { resolve } from 'node:path';
import 'dotenv/config';  // Load .env file

import { runAgent } from './agent.js';
import { createSession, loadSession, saveSession } from './session.js';
import type { AgentConfig } from './types.js';

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || fallback;
}

function parseArgs(argv: string[]): {
  prompt: string;
  cwd: string;
  resumeSessionId?: string;
} {
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

  if (!prompt) {
    console.error('Usage:');
    console.error('  OPENROUTER_API_KEY=... npm start -- "你的任务"');
    console.error('  npm start -- --cwd /path/to/project "你的任务"');
    console.error('  npm start -- --resume <session_id> "继续上次的工作"');
    console.error('');
    console.error('Optional env:');
    console.error('  OPENAI_BASE_URL  (default: https://openrouter.ai/api/v1)');
    console.error('  MODEL            (default: deepseek/deepseek-chat)');
    console.error('  MAX_TURNS        (default: 10)');
    console.error('  ALLOW_SHELL=1    enable run_shell tool');
    process.exit(1);
  }

  return { prompt, cwd, resumeSessionId };
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const { prompt, cwd, resumeSessionId } = parseArgs(rawArgv);

  const apiKey = env('OPENAI_API_KEY') ?? env('OPENROUTER_API_KEY');
  if (!apiKey) {
    console.error('Missing OPENAI_API_KEY or OPENROUTER_API_KEY');
    process.exit(1);
  }

  const config: AgentConfig = {
    apiKey,
    baseUrl: env('OPENAI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai')!,
    model: env('MODEL', 'gemini-2.0-flash')!,
    maxTurns: Number(env('MAX_TURNS', '10')),
    cwd,
    allowShell: env('ALLOW_SHELL') === '1',
  };

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
  console.log(`shell: ${config.allowShell ? 'on' : 'off'}`);
  console.log(`session: ${session.session_id}`);
  console.log('─'.repeat(60));
  console.log(`task: ${prompt}\n`);

  const answer = await runAgent({
    prompt,
    config,
    session,
    sessionId: session.session_id,
    onStep(event) {
      switch (event.type) {
        case 'turn_start':
          console.log(`\n[turn ${event.turn}] ── LLM ──`);
          break;
        case 'llm_done':
          console.log(
            `  finish=${event.finishReason ?? 'null'} tokens=${JSON.stringify(event.usage ?? {})}`,
          );
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
  console.log(answer.text);
  console.log('─'.repeat(60));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});