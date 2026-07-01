import * as readline from 'node:readline';
import { resolve } from 'node:path';

import type { AgentRuntime } from '../runner.js';
import {
  defaultPrefs,
  formatApproveStatus,
  loadPrefs,
  mergePrefs,
  type TuiPrefs,
} from './prefs.js';
import { isSlashCommand, parseSlashLine, SLASH_HELP_LINES } from './slash.js';
import { printRuntimeEvent } from './log.js';
import { resetMarkdownTerminal } from './markdown.js';
import { CompressionFatigueTracker } from '../compression-fatigue.js';
import { createFatiguePrompter } from './fatigue-prompt.js';
import { createPermissionPrompter, createWorkflowConfirm } from './permission-prompt.js';

export interface TuiAppOptions {
  runtime: AgentRuntime;
  noShell?: boolean;
  noWeb?: boolean;
  allowWeb?: boolean;
}

type AppMode = 'confirm' | 'idle' | 'running';

function printBanner(runtime: AgentRuntime, shellOn: boolean, webOn: boolean): void {
  console.log('─'.repeat(60));
  console.log('minimal-agent-ts TUI  (scroll log + slash REPL)');
  console.log(`model:   ${runtime.config.model}`);
  console.log(`cwd:     ${runtime.config.cwd}`);
  console.log(`session: ${runtime.session.session_id}`);
  console.log(`shell:   ${shellOn ? 'on' : 'off'}   web: ${webOn ? 'on' : 'off'}`);
  console.log('slash:   /help   while running: Ctrl+C to abort');
  console.log('─'.repeat(60));
}

function printStatus(runtime: AgentRuntime, armedWorkflow: string | null): void {
  const wf = armedWorkflow ? `  workflow armed: ${armedWorkflow}` : '';
  console.log(
    `[${runtime.session.session_id}] shell:${runtime.config.allowShell ? 'on' : 'off'} web:${runtime.config.allowWeb ? 'on' : 'off'}${wf}`,
  );
}

export async function runTuiApp(opts: TuiAppOptions): Promise<void> {
  const { runtime } = opts;

  const saved = loadPrefs(runtime.config.cwd);
  const needsConfirm = saved === null;
  let prefs: TuiPrefs = saved ?? defaultPrefs();

  let shellOn = prefs.allowShell;
  let webOn = prefs.allowWeb;

  if (prefs.alwaysShell && !opts.noShell) shellOn = true;
  if (prefs.alwaysWeb && !opts.noWeb) webOn = true;
  if (opts.noShell) shellOn = false;
  if (opts.noWeb) webOn = false;
  if (opts.allowWeb) webOn = true;

  runtime.setAllowShell(shellOn);
  runtime.setAllowWeb(webOn);
  runtime.permissionGate.setAlwaysGrants({
    shell: Boolean(prefs.alwaysShell),
    web: Boolean(prefs.alwaysWeb),
  });

  let mode: AppMode = needsConfirm ? 'confirm' : 'idle';
  let confirmShell = shellOn;
  let confirmWeb = webOn;
  let armedWorkflow: string | null = null;

  printBanner(runtime, shellOn, webOn);

  if (runtime.hasPendingHandoff()) {
    console.log('(handoff loaded — will inject on next task)');
  }

  if (prefs.alwaysShell || prefs.alwaysWeb) {
    const always: string[] = [];
    if (prefs.alwaysShell) always.push('shell');
    if (prefs.alwaysWeb) always.push('web');
    console.log(`\n⚠ always-approve: ${always.join(', ')} (from .tui-prefs.json)`);
  }

  if (needsConfirm) {
    console.log('\nFirst run — confirm tools (Enter=ok, s=toggle shell, w=toggle web):');
    console.log(`  shell [${confirmShell ? 'on' : 'off'}]  web [${confirmWeb ? 'on' : 'off'}]`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: '› ',
  });

  const basePermissionPrompter = createPermissionPrompter();
  runtime.permissionGate.setPrompter(async (req) => {
    const choice = await basePermissionPrompter(req);
    if (choice === 'session') {
      if (req.kind === 'shell') {
        runtime.setAllowShell(true);
        shellOn = true;
        prefs = mergePrefs(runtime.config.cwd, { allowShell: true, allowWeb: webOn });
      } else {
        runtime.setAllowWeb(true);
        webOn = true;
        prefs = mergePrefs(runtime.config.cwd, { allowShell: shellOn, allowWeb: true });
      }
    }
    return choice;
  });
  runtime.setWorkflowConfirmFn(createWorkflowConfirm());

  const setPrompt = (): void => {
    if (mode === 'confirm') {
      rl.setPrompt('› confirm ');
    } else if (armedWorkflow) {
      rl.setPrompt(`› [${armedWorkflow}] `);
    } else {
      rl.setPrompt('› ');
    }
  };

  const showPrompt = (): void => {
    setPrompt();
    rl.prompt();
  };

  const fatigueTracker = new CompressionFatigueTracker();

  const finishRun = async (): Promise<void> => {
    mode = 'idle';
    rl.resume();
    if (fatigueTracker.shouldPrompt()) {
      rl.pause();
      const choice = await createFatiguePrompter(fatigueTracker.stats())();
      fatigueTracker.snooze();
      if (choice === 'handoff') {
        const { path, fromSessionId } = runtime.newSessionWithHandoff();
        armedWorkflow = null;
        runtime.armWorkflow(null);
        fatigueTracker.reset();
        console.log(`Handoff from ${fromSessionId} → ${path}`);
        console.log(
          `New session: ${runtime.session.session_id} (handoff queued for next task)`,
        );
        printStatus(runtime, armedWorkflow);
      } else if (choice === 'clear') {
        runtime.clearCurrentContext();
        console.log('Context cleared (completed task summaries kept)');
      }
      rl.resume();
    }
    showPrompt();
  };

  runtime.onEvent((event) => {
    if (event.type === 'run_start') {
      mode = 'running';
      rl.pause();
      console.log('(input paused — Ctrl+C to abort)');
    }
    if (event.type === 'compression') {
      fatigueTracker.onCompression(event.turn, event.pruned ?? 0);
    }
    printRuntimeEvent(event);
    if (event.type === 'run_end') {
      void finishRun();
    }
  });

  const handleSlash = async (
    result: ReturnType<typeof parseSlashLine>,
  ): Promise<void> => {
    if (!result) return;

    if (result.stop) {
      if (runtime.isRunning()) {
        console.log('… stopping');
        runtime.abort();
      } else {
        console.log('(not running)');
      }
      showPrompt();
      return;
    }

    if (result.quit) {
      runtime.saveIfDirty();
      rl.close();
      await runtime.shutdown();
      process.exit(0);
    }

    if (
      runtime.isRunning() &&
      (result.message === '__resume_last__' ||
        result.message?.startsWith('__resume__') ||
        result.armWorkflow !== undefined ||
        result.runWorkflow)
    ) {
      console.log('Busy — /stop or Ctrl+C first');
      showPrompt();
      return;
    }

    if (result.message === '__help__') {
      for (const line of SLASH_HELP_LINES) console.log(`  ${line}`);
      showPrompt();
      return;
    }

    if (result.message === '__sessions__') {
      const sessions = runtime.listSessions().slice(0, 20);
      if (sessions.length === 0) {
        console.log('(no sessions)');
      } else {
        for (const s of sessions) {
          console.log(
            `  ${s.session_id}  tasks=${s.task_count}  ${new Date(s.created_at).toISOString().slice(0, 16)}`,
          );
        }
      }
      showPrompt();
      return;
    }

    if (result.message === '__new__') {
      runtime.newSession();
      armedWorkflow = null;
      runtime.armWorkflow(null);
      fatigueTracker.reset();
      console.log(`New session: ${runtime.session.session_id}`);
      printStatus(runtime, armedWorkflow);
      showPrompt();
      return;
    }

    if (result.newSessionHandoff) {
      const { path, fromSessionId } = runtime.newSessionWithHandoff();
      armedWorkflow = null;
      runtime.armWorkflow(null);
      fatigueTracker.reset();
      console.log(`Handoff from ${fromSessionId} → ${path}`);
      console.log(`New session: ${runtime.session.session_id} (handoff queued)`);
      printStatus(runtime, armedWorkflow);
      showPrompt();
      return;
    }

    if (result.clearContext) {
      runtime.clearCurrentContext();
      fatigueTracker.reset();
      console.log('Context cleared (task summaries kept)');
      showPrompt();
      return;
    }

    if (result.handoffWrite) {
      const path = runtime.writeHandoff();
      console.log(`Handoff written: ${path}`);
      showPrompt();
      return;
    }

    if (result.handoffLoad !== undefined) {
      const sid = result.handoffLoad || undefined;
      const path = runtime.loadHandoffForNextTask(sid);
      if (!path) {
        console.log(
          sid ? `No handoff for session ${sid}` : '(no handoff file for current session)',
        );
      } else {
        console.log(`Handoff loaded from ${path} — queued for next task`);
      }
      showPrompt();
      return;
    }

    if (result.message === '__resume_last__') {
      if (!runtime.resumeLatestSession()) {
        console.log('(no saved sessions)');
      } else {
        console.log(
          `Resumed latest ${runtime.session.session_id} (${runtime.session.tasks.length} tasks)`,
        );
        printStatus(runtime, armedWorkflow);
      }
      showPrompt();
      return;
    }

    if (result.message?.startsWith('__resume__')) {
      const id = result.message.slice('__resume__:'.length);
      if (!runtime.resumeSession(id)) {
        console.log(`Session not found: ${id}`);
      } else {
        console.log(`Resumed ${id} (${runtime.session.tasks.length} tasks)`);
        printStatus(runtime, armedWorkflow);
      }
      showPrompt();
      return;
    }

    if (result.message === '__shell_status__') {
      console.log(`shell: ${runtime.config.allowShell ? 'on' : 'off'}  (/shell on|off)`);
      showPrompt();
      return;
    }

    if (result.message === '__web_status__') {
      console.log(`web: ${runtime.config.allowWeb ? 'on' : 'off'}  (/web on|off)`);
      showPrompt();
      return;
    }

    if (result.message?.startsWith('__shell__:')) {
      const on = result.message.endsWith('on');
      runtime.setAllowShell(on);
      shellOn = on;
      console.log(`shell ${on ? 'on' : 'off'}`);
      showPrompt();
      return;
    }

    if (result.message?.startsWith('__web__:')) {
      const on = result.message.endsWith('on');
      runtime.setAllowWeb(on);
      webOn = on;
      console.log(`web ${on ? 'on' : 'off'}`);
      showPrompt();
      return;
    }

    if (result.message === '__approve_status__') {
      prefs = loadPrefs(runtime.config.cwd) ?? defaultPrefs();
      console.log(
        formatApproveStatus({
          allowShell: runtime.config.allowShell,
          allowWeb: runtime.config.allowWeb,
          alwaysShell: prefs.alwaysShell,
          alwaysWeb: prefs.alwaysWeb,
        }),
      );
      showPrompt();
      return;
    }

    if (result.message?.startsWith('__approve_session__:')) {
      const kind = result.message.slice('__approve_session__:'.length);
      if (kind === 'shell' || kind === 'web') {
        runtime.permissionGate.grantSession(kind);
        if (kind === 'shell') {
          runtime.setAllowShell(true);
          shellOn = true;
          prefs = mergePrefs(runtime.config.cwd, { allowShell: true });
        } else {
          runtime.setAllowWeb(true);
          webOn = true;
          prefs = mergePrefs(runtime.config.cwd, { allowWeb: true });
        }
        console.log(`${kind} approved for this session`);
      }
      showPrompt();
      return;
    }

    if (result.message?.startsWith('__approve_always__:')) {
      const kind = result.message.slice('__approve_always__:'.length);
      if (kind === 'shell' || kind === 'web') {
        if (kind === 'shell') {
          runtime.setAllowShell(true);
          shellOn = true;
          prefs = mergePrefs(runtime.config.cwd, { allowShell: true, alwaysShell: true });
        } else {
          runtime.setAllowWeb(true);
          webOn = true;
          prefs = mergePrefs(runtime.config.cwd, { allowWeb: true, alwaysWeb: true });
        }
        runtime.permissionGate.setAlwaysGrants({
          shell: Boolean(prefs.alwaysShell),
          web: Boolean(prefs.alwaysWeb),
        });
        console.log(`${kind} always-approved (saved to .tui-prefs.json)`);
      }
      showPrompt();
      return;
    }

    if (result.message?.startsWith('__approve_revoke__:')) {
      const kind = result.message.slice('__approve_revoke__:'.length);
      if (kind === 'shell' || kind === 'web') {
        prefs = mergePrefs(
          runtime.config.cwd,
          kind === 'shell' ? { alwaysShell: false } : { alwaysWeb: false },
        );
        runtime.permissionGate.setAlwaysGrants({
          shell: Boolean(prefs.alwaysShell),
          web: Boolean(prefs.alwaysWeb),
        });
        console.log(`revoked always-approve for ${kind}`);
      }
      showPrompt();
      return;
    }

    if (result.message === '__skills__') {
      const skills = runtime.listSkills();
      if (skills.length === 0) {
        console.log('(no skills)');
      } else {
        for (const s of skills) {
          console.log(`  ${s.name}: ${s.description.slice(0, 72)}`);
        }
      }
      showPrompt();
      return;
    }

    if (result.message?.startsWith('__skill_load__:')) {
      const name = result.message.slice('__skill_load__:'.length);
      runtime.loadSkill(name);
      console.log(`Loaded skill: ${name} (next task)`);
      showPrompt();
      return;
    }

    if (result.message === '__tools__') {
      for (const t of runtime.listToolNames()) {
        console.log(`  • ${t}`);
      }
      showPrompt();
      return;
    }

    if (result.message === '__spawns__') {
      const presets = runtime.listSpawnPresets();
      if (presets.length === 0) {
        console.log('(no spawn presets — add spawn_presets to agent.json)');
      } else {
        for (const p of presets) {
          console.log(`  • ${p.name}: ${p.description}`);
          console.log(`    tools: ${p.tools.join(', ')}`);
        }
      }
      showPrompt();
      return;
    }

    if (result.message?.startsWith('__cwd__:')) {
      const path = result.message.slice('__cwd__:'.length);
      runtime.setCwd(resolve(path));
      console.log(`cwd → ${runtime.config.cwd}`);
      showPrompt();
      return;
    }

    if (result.message === '__workflow_list__') {
      const wfs = runtime.listWorkflows();
      if (wfs.length === 0) console.log('(no workflows)');
      else for (const w of wfs) console.log(`  • ${w}`);
      showPrompt();
      return;
    }

    if (result.armWorkflow !== undefined) {
      const name = result.armWorkflow;
      if (name === null) {
        runtime.armWorkflow(null);
        armedWorkflow = null;
        console.log('Workflow disarmed');
      } else {
        const path = runtime.resolveWorkflowPath(name);
        if (!path) {
          console.log(`Workflow not found: ${name}`);
        } else {
          runtime.armWorkflow(path);
          armedWorkflow = name;
          console.log(`Armed workflow: ${name} — next line is the task`);
        }
      }
      showPrompt();
      return;
    }

    if (result.runWorkflow) {
      const path = runtime.resolveWorkflowPath(result.runWorkflow.path);
      if (!path) {
        console.log(`Workflow not found: ${result.runWorkflow.path}`);
        showPrompt();
        return;
      }
      await runTask(result.runWorkflow.task, path);
      return;
    }

    if (result.message) {
      console.log(result.message);
      showPrompt();
    }
  };

  const runTask = async (task: string, workflowPath?: string): Promise<void> => {
    if (runtime.hasPendingHandoff()) {
      console.log('(injecting handoff context)');
    }
    console.log(`\n▶ ${task.slice(0, 120)}${task.length > 120 ? '…' : ''}`);
    armedWorkflow = null;
    try {
      if (workflowPath) {
        await runtime.runWorkflowTask(task, workflowPath);
      } else {
        await runtime.runTask(task);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗ ${msg}`);
      mode = 'idle';
      rl.resume();
      showPrompt();
    }
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();

    if (mode === 'confirm') {
      if (isSlashCommand(trimmed)) {
        void handleSlash(parseSlashLine(trimmed));
        return;
      }
      if (trimmed === 's') {
        confirmShell = !confirmShell;
        console.log(`  shell [${confirmShell ? 'on' : 'off'}]  web [${confirmWeb ? 'on' : 'off'}]`);
        showPrompt();
        return;
      }
      if (trimmed === 'w') {
        confirmWeb = !confirmWeb;
        console.log(`  shell [${confirmShell ? 'on' : 'off'}]  web [${confirmWeb ? 'on' : 'off'}]`);
        showPrompt();
        return;
      }
      runtime.setAllowShell(confirmShell);
      runtime.setAllowWeb(confirmWeb);
      prefs = mergePrefs(runtime.config.cwd, {
        allowShell: confirmShell,
        allowWeb: confirmWeb,
      });
      mode = 'idle';
      console.log(`Tools: shell:${confirmShell ? 'on' : 'off'} web:${confirmWeb ? 'on' : 'off'}`);
      showPrompt();
      return;
    }

    if (!trimmed) {
      showPrompt();
      return;
    }

    if (isSlashCommand(trimmed)) {
      void handleSlash(parseSlashLine(trimmed));
      return;
    }

    void runTask(trimmed);
  });

  process.on('SIGINT', () => {
    if (runtime.isRunning()) {
      console.log('\n… Ctrl+C abort');
      runtime.abort();
      return;
    }
    runtime.saveIfDirty();
    rl.close();
    void runtime.shutdown().finally(() => process.exit(0));
  });

  process.stdout.on('resize', () => resetMarkdownTerminal());

  showPrompt();
}