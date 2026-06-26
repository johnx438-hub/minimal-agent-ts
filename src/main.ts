import { resolve } from 'node:path';

import { runAgent } from './agent.js';
import type { AgentConfig } from './types.js';

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || fallback;
}

function parseArgs(argv: string[]): { prompt: string; cwd: string } {
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
    console.error('');
    console.error('Optional env:');
    console.error('  OPENAI_BASE_URL  (default: https://openrouter.ai/api/v1)');
    console.error('  MODEL            (default: deepseek/deepseek-chat)');
    console.error('  MAX_TURNS        (default: 10)');
    console.error('  ALLOW_SHELL=1    enable run_shell tool');
    process.exit(1);
  }

  return { prompt, cwd };
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const { prompt, cwd } = parseArgs(rawArgv);

  const apiKey = env('OPENROUTER_API_KEY') ?? env('OPENAI_API_KEY');
  if (!apiKey) {
    console.error('Missing OPENROUTER_API_KEY or OPENAI_API_KEY');
    process.exit(1);
  }

  const config: AgentConfig = {
    apiKey,
    baseUrl: env('OPENAI_BASE_URL', 'https://openrouter.ai/api/v1')!,
    model: env('MODEL', 'deepseek/deepseek-chat')!,
    maxTurns: Number(env('MAX_TURNS', '10')),
    cwd,
    allowShell: env('ALLOW_SHELL') === '1',
  };

  console.log('─'.repeat(60));
  console.log('minimal-agent-ts');
  console.log(`model: ${config.model}`);
  console.log(`cwd:   ${config.cwd}`);
  console.log(`shell: ${config.allowShell ? 'on' : 'off'}`);
  console.log('─'.repeat(60));
  console.log(`task: ${prompt}\n`);

  const answer = await runAgent({
    prompt,
    config,
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
  });

  console.log('\n' + '─'.repeat(60));
  console.log(answer);
  console.log('─'.repeat(60));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});