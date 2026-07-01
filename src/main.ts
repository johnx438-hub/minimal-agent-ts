import { resolve } from 'node:path';
import 'dotenv/config';

import type { RuntimeEvent } from './events.js';
import { AgentRuntime, printStepEvent } from './runner.js';
import { formatWorkflowCheckpoint } from './workflow-checkpoint.js';
import { toolRegistry } from './tools/registry.js';

function parseArgs(argv: string[]): {
  prompt: string;
  cwd: string;
  resumeSessionId?: string;
  listTools: boolean;
  loadSkills: string[];
  allowShell: boolean;
  allowWeb: boolean;
  workflowPath?: string;
  jsonEvents: boolean;
  resumeLatest: boolean;
  confirmWorkflow: boolean;
  loadHandoffFrom?: string;
} {
  let listTools = false;
  const loadSkills: string[] = [];
  let allowShell = false;
  let allowWeb = false;
  let jsonEvents = false;

  const shellIdx = argv.indexOf('--allow-shell');
  if (shellIdx >= 0) {
    allowShell = true;
    argv = [...argv.slice(0, shellIdx), ...argv.slice(shellIdx + 1)];
  }

  const webIdx = argv.indexOf('--allow-web');
  if (webIdx >= 0) {
    allowWeb = true;
    argv = [...argv.slice(0, webIdx), ...argv.slice(webIdx + 1)];
  }

  const jsonIdx = argv.indexOf('--json-events');
  if (jsonIdx >= 0) {
    jsonEvents = true;
    argv = [...argv.slice(0, jsonIdx), ...argv.slice(jsonIdx + 1)];
  }

  const listIdx = argv.indexOf('--list-tools');
  if (listIdx >= 0) {
    listTools = true;
    argv = [...argv.slice(0, listIdx), ...argv.slice(listIdx + 1)];
  }

  let workflowPath: string | undefined;
  const workflowIdx = argv.indexOf('--workflow');
  if (workflowIdx >= 0 && argv[workflowIdx + 1]) {
    workflowPath = argv[workflowIdx + 1];
    argv = [...argv.slice(0, workflowIdx), ...argv.slice(workflowIdx + 2)];
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

  let resumeSessionId: string | undefined;
  let resumeLatest = false;
  let confirmWorkflow = false;
  let loadHandoffFrom: string | undefined;

  const resumeIdx = argv.indexOf('--resume');
  if (resumeIdx >= 0 && argv[resumeIdx + 1]) {
    resumeSessionId = argv[resumeIdx + 1];
    argv = [...argv.slice(0, resumeIdx), ...argv.slice(resumeIdx + 2)];
  }

  if (argv.includes('--resume-last')) {
    resumeLatest = true;
    argv = argv.filter((a) => a !== '--resume-last');
  }

  if (argv.includes('--confirm-workflow')) {
    confirmWorkflow = true;
    argv = argv.filter((a) => a !== '--confirm-workflow');
  }

  const handoffIdx = argv.indexOf('--handoff');
  if (handoffIdx >= 0) {
    const next = argv[handoffIdx + 1];
    if (next && !next.startsWith('-')) {
      loadHandoffFrom = next;
      argv = [...argv.slice(0, handoffIdx), ...argv.slice(handoffIdx + 2)];
    } else {
      loadHandoffFrom = 'last';
      argv = [...argv.slice(0, handoffIdx), ...argv.slice(handoffIdx + 1)];
    }
  }

  const dash = argv.indexOf('--');
  const prompt =
    dash >= 0 ? argv.slice(dash + 1).join(' ').trim() : argv.join(' ').trim();

  let cwd = process.cwd();
  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx >= 0 && argv[cwdIdx + 1]) {
    cwd = resolve(argv[cwdIdx + 1]);
  }

  if (!prompt && !listTools && !workflowPath) {
    console.error('Usage:');
    console.error('  OPENROUTER_API_KEY=... npm start -- "你的任务"');
    console.error('  npm start -- --cwd /path/to/project "你的任务"');
    console.error('  npm start -- --resume <session_id> "继续上次的工作"');
    console.error('  npm start -- --resume-last "继续最近一次 session"');
    console.error('  npm start -- --list-tools');
    console.error('  npm start -- --load-skills context-design "任务"');
    console.error('  npm start -- --workflow workflows/review-loop.json --confirm-workflow "任务"');
    console.error('  npm start -- --handoff [session_id] "新 session 注入 handoff"');
    console.error('  npm start -- --json-events -- "任务"');
    console.error('');
    console.error('Optional env:');
    console.error('  OPENAI_BASE_URL  (default: Gemini OpenAI-compatible URL)');
    console.error('  MODEL            (default: gemini-2.0-flash)');
    console.error('  MAX_TURNS        (default: 0 = unlimited; loop guard + hard ceiling)');
    console.error('  LOOP_HARD_CEILING (default: 200)');
    console.error('  LOOP_GUARD       inject | terminate | off (default: inject)');
    console.error('  --allow-shell    enable run_shell tool (or ALLOW_SHELL=1)');
    console.error('  --allow-web      enable web_fetch tool (or ALLOW_WEB=1)');
    console.error('');
    console.error('Plugins: agent.json (builtin_tools, mcp_servers, skills_dirs, web_fetch_policy)');
    process.exit(1);
  }

  return {
    prompt,
    cwd,
    resumeSessionId,
    listTools,
    loadSkills,
    allowShell,
    allowWeb,
    workflowPath,
    jsonEvents,
    resumeLatest,
    confirmWorkflow,
    loadHandoffFrom,
  };
}

function defsCountMcp(defs: { function: { name: string } }[]): number {
  return defs.filter((d) => d.function.name.startsWith('mcp_')).length;
}

function onRuntimeEvent(event: RuntimeEvent, jsonEvents: boolean): void {
  if (jsonEvents) return;
  if (event.type === 'workflow_step') {
    const round = event.round !== undefined ? ` round ${event.round}` : '';
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`workflow ▶ ${event.phase} / ${event.role}${round}`);
    console.log('═'.repeat(60));
    return;
  }
  if (event.type === 'workflow_handback') {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`workflow handback ▶ ${event.workflow} (${event.reason})`);
    if (event.role) {
      console.log(
        `  role: ${event.role}${event.round !== undefined ? ` round ${event.round}` : ''}`,
      );
    }
    console.log(`  ${event.detail}`);
    console.log('═'.repeat(60));
    return;
  }
  if (event.type === 'spawn_start') {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`spawn ▶ ${event.preset}`);
    console.log('═'.repeat(60));
    return;
  }
  if (event.type === 'spawn_end') {
    console.log(
      event.ok
        ? `\nspawn ✓ ${event.preset}`
        : `\nspawn ✗ ${event.preset}: ${event.detail ?? 'failed'}`,
    );
    return;
  }
  if (
    event.type === 'run_start' ||
    event.type === 'run_end' ||
    event.type === 'session_saved' ||
    event.type === 'runtime'
  ) {
    return;
  }
  printStepEvent(event);
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const {
    prompt,
    cwd,
    resumeSessionId,
    listTools,
    loadSkills,
    allowShell,
    allowWeb,
    workflowPath,
    jsonEvents,
    resumeLatest,
    confirmWorkflow,
    loadHandoffFrom,
  } = parseArgs([...rawArgv]);

  const runtime = new AgentRuntime({
    cwd,
    resumeSessionId,
    resumeLatest,
    loadSkills,
    allowShell,
    allowWeb,
    jsonEvents,
    loadHandoffFrom,
  });

  if (workflowPath && confirmWorkflow) {
    runtime.setWorkflowConfirmFn(async (info) => {
      if (!jsonEvents) {
        console.error(formatWorkflowCheckpoint(info));
        console.error('(--confirm-workflow: proceeding)');
      }
      return true;
    });
  }

  await runtime.initialize();

  if (listTools) {
    const defs = toolRegistry.getDefinitions(runtime.config);
    console.log('Available tools:');
    for (const def of defs) {
      console.log(`  - ${def.function.name}`);
    }
    console.log(`Skills: ${toolRegistry.listSkillNames().join(', ') || '(none)'}`);
    if (!runtime.config.allowShell) {
      console.log('Note: run_shell hidden until --allow-shell or ALLOW_SHELL=1');
    }
    if (!runtime.config.allowWeb) {
      console.log('Note: web_fetch hidden until --allow-web or ALLOW_WEB=1');
    }
    await runtime.shutdown();
    return;
  }

  const mcpCount = defsCountMcp(toolRegistry.getDefinitions(runtime.config));
  if (!jsonEvents) {
    if (mcpCount > 0) {
      console.log(`mcp: ${mcpCount} tools loaded`);
    }
    const skillNames = toolRegistry.listSkillNames();
    if (skillNames.length > 0) {
      console.log(`skills: ${skillNames.join(', ')}`);
    }
    if (resumeSessionId) {
      console.log(
        `Resumed session: ${runtime.session!.session_id} (${runtime.session!.tasks.length} previous tasks)`,
      );
    } else {
      console.log(`New session: ${runtime.session!.session_id}`);
    }
    console.log('─'.repeat(60));
    console.log('minimal-agent-ts');
    console.log(`model: ${runtime.config.model}`);
    console.log(`cwd:   ${runtime.config.cwd}`);
    console.log(
      `shell: ${runtime.config.allowShell ? 'on' : 'off (use --allow-shell)'}`,
    );
    console.log(`web:   ${runtime.config.allowWeb ? 'on' : 'off (use --allow-web)'}`);
    console.log(`session: ${runtime.session!.session_id}`);
    console.log('─'.repeat(60));
    if (workflowPath) {
      console.log(`workflow: ${workflowPath}`);
    }
    console.log(`task: ${prompt}\n`);
  }

  runtime.onEvent((event) => onRuntimeEvent(event, jsonEvents));

  let finalText: string;

  if (workflowPath) {
    const wfResult = await runtime.runWorkflowTask(prompt, workflowPath);
    finalText = wfResult.text;
    if (!jsonEvents) {
      console.log(
        `\nworkflow done (session ${runtime.session!.session_id})`,
      );
    }
  } else {
    const answer = await runtime.runTask(prompt);
    finalText = answer.text;
  }

  if (!jsonEvents) {
    console.log('\n' + '─'.repeat(60));
    if (process.env.STREAM !== '0') {
      // streamed during run
    } else {
      console.log(finalText);
    }
    console.log('─'.repeat(60));
  }

  await runtime.shutdown();
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });