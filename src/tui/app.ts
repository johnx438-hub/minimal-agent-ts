import * as readline from 'node:readline';
import { resolve } from 'node:path';

import type { AgentRuntime } from '../runner.js';
import { formatSessionPickerDescription } from '../session.js';
import {
  defaultPrefs,
  formatApproveStatus,
  loadPrefs,
  mergePrefs,
  normalizePrefs,
  prefsPath,
  resolvePrefsRoot,
  type TuiPrefs,
} from './prefs.js';
import {
  isSlashCommand,
  normalizeReplInput,
  parseSlashLine,
  SLASH_HELP_LINES,
} from './slash.js';
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

type AppMode = 'confirm' | 'idle' | 'running' | 'stopping';

function printBanner(runtime: AgentRuntime, shellOn: boolean, webOn: boolean): void {
  console.log('─'.repeat(60));
  console.log('minimal-agent-ts TUI  (scroll log + slash REPL)');
  console.log(`model:   ${runtime.config.model}`);
  console.log(`cwd:     ${runtime.config.cwd}`);
  console.log(`session: ${runtime.sessionLabel()}`);
  if (!runtime.hasActiveSession()) {
    console.log('  (lazy — /resume, /new, or first task creates a session)');
  }
  console.log(`shell:   ${shellOn ? 'on' : 'off'}   web: ${webOn ? 'on' : 'off'}`);
  console.log('slash:   /help   while running: /stop, Esc, or Ctrl+C to abort');
  console.log('─'.repeat(60));
}

function printStatus(runtime: AgentRuntime, armedWorkflow: string | null): void {
  const wf = armedWorkflow ? `  workflow armed: ${armedWorkflow}` : '';
  console.log(
    `[${runtime.sessionLabel()}] shell:${runtime.config.allowShell ? 'on' : 'off'} web:${runtime.config.allowWeb ? 'on' : 'off'}${wf}`,
  );
}

export async function runTuiApp(opts: TuiAppOptions): Promise<void> {
  const { runtime } = opts;
  /** Prefs live at project root (agent.json / existing .tui-prefs.json), not agent `/cwd`. */
  const prefsAnchor = resolvePrefsRoot(runtime.config.cwd);

  const saved = loadPrefs(prefsAnchor);
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

  let mode: AppMode = needsConfirm ? 'confirm' : 'idle';
  let confirmShell = shellOn;
  let confirmWeb = webOn;
  let armedWorkflow: string | null = null;

  const applyAlwaysFromPrefs = (p: TuiPrefs): void => {
    const normalized = normalizePrefs(p);
    runtime.permissionGate.setAlwaysGrants({
      shell: Boolean(normalized.alwaysShell),
      web: Boolean(normalized.alwaysWeb),
    });
    if (normalized.alwaysShell) {
      runtime.setAllowShell(true);
      shellOn = true;
      confirmShell = true;
    }
    if (normalized.alwaysWeb) {
      runtime.setAllowWeb(true);
      webOn = true;
      confirmWeb = true;
    }
  };

  applyAlwaysFromPrefs(prefs);

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
        // session grant: runtime only (SPEC: /shell /web do not persist)
      } else {
        runtime.setAllowWeb(true);
        webOn = true;
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
  let lastRunAborted = false;

  const requestStop = (): void => {
    if (!runtime.isRunning()) return;
    mode = 'stopping';
    console.log('… stopping');
    runtime.abort();
  };

  const finishRun = async (): Promise<void> => {
    mode = 'idle';
    if (!lastRunAborted && fatigueTracker.shouldPrompt()) {
      rl.pause();
      const choice = await createFatiguePrompter(fatigueTracker.stats())();
      fatigueTracker.snooze();
      if (choice === 'handoff') {
        const handoff = runtime.newSessionWithHandoff();
        if (!handoff) {
          console.log('(no active session — nothing to hand off)');
        } else {
          const { path, fromSessionId } = handoff;
          armedWorkflow = null;
          runtime.armWorkflow(null);
          fatigueTracker.reset();
          console.log(`Handoff from ${fromSessionId} → ${path}`);
          console.log(
            `New session: ${runtime.sessionLabel()} (handoff queued for next task)`,
          );
        }
        printStatus(runtime, armedWorkflow);
      } else if (choice === 'clear') {
        if (!runtime.clearCurrentContext()) {
          console.log('(no active session)');
        } else {
          console.log('Context cleared (completed task summaries kept)');
        }
      }
      rl.resume();
    }
    showPrompt();
  };

  runtime.onEvent((event) => {
    if (event.type === 'run_start') {
      mode = 'running';
      lastRunAborted = false;
      console.log('(running — /stop or Ctrl+C to abort; other slash commands still work)');
    }
    if (event.type === 'run_stopping') {
      mode = 'stopping';
      console.log('… stopping (waiting for current step)');
    }
    if (event.type === 'compression') {
      fatigueTracker.onCompression(
        event.turn,
        (event.pruned ?? 0) + (event.pointer_compacted ?? 0),
      );
    }
    printRuntimeEvent(event);
    if (event.type === 'run_end') {
      lastRunAborted = event.reason === 'aborted';
      void finishRun();
    }
  });

  const handleSlash = async (
    result: ReturnType<typeof parseSlashLine>,
  ): Promise<void> => {
    if (!result) return;

    if (result.stop) {
      if (runtime.isRunning()) {
        requestStop();
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
          console.log(`  ${s.session_id}`);
          console.log(`    ${formatSessionPickerDescription(s)}`);
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
      console.log(`New session: ${runtime.sessionLabel()}`);
      printStatus(runtime, armedWorkflow);
      showPrompt();
      return;
    }

    if (result.newSessionHandoff) {
      const handoff = runtime.newSessionWithHandoff();
      if (!handoff) {
        console.log('(no active session — nothing to hand off)');
      } else {
        const { path, fromSessionId } = handoff;
        armedWorkflow = null;
        runtime.armWorkflow(null);
        fatigueTracker.reset();
        console.log(`Handoff from ${fromSessionId} → ${path}`);
        console.log(`New session: ${runtime.sessionLabel()} (handoff queued)`);
        printStatus(runtime, armedWorkflow);
      }
      showPrompt();
      return;
    }

    if (result.clearContext) {
      if (!runtime.clearCurrentContext()) {
        console.log('(no active session)');
      } else {
        fatigueTracker.reset();
        console.log('Context cleared (task summaries kept)');
      }
      showPrompt();
      return;
    }

    if (result.handoffWrite) {
      const path = runtime.writeHandoff();
      if (!path) console.log('(no active session)');
      else console.log(`Handoff written: ${path}`);
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
          `Resumed active session ${runtime.sessionLabel()} (${runtime.session!.tasks.length} tasks)`,
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
        console.log(`Resumed ${id} (${runtime.session!.tasks.length} tasks)`);
        printStatus(runtime, armedWorkflow);
      }
      showPrompt();
      return;
    }

    if (result.message === '__shell_status__') {
      const always = prefs.alwaysShell ? ' (always in prefs)' : '';
      console.log(
        `shell: ${runtime.config.allowShell ? 'on' : 'off'}${always}  (/shell on|off, session-only)`,
      );
      showPrompt();
      return;
    }

    if (result.message === '__web_status__') {
      const always = prefs.alwaysWeb ? ' (always in prefs)' : '';
      console.log(
        `web: ${runtime.config.allowWeb ? 'on' : 'off'}${always}  (/web on|off, session-only)`,
      );
      showPrompt();
      return;
    }

    if (result.message?.startsWith('__shell__:')) {
      const on = result.message.endsWith('on');
      if (!on && prefs.alwaysShell) {
        console.log('shell is always-approved — use /approve revoke always shell');
        showPrompt();
        return;
      }
      runtime.setAllowShell(on);
      shellOn = on;
      confirmShell = on;
      console.log(`shell ${on ? 'on' : 'off'} (this session only)`);
      showPrompt();
      return;
    }

    if (result.message?.startsWith('__web__:')) {
      const on = result.message.endsWith('on');
      if (!on && prefs.alwaysWeb) {
        console.log('web is always-approved — use /approve revoke always web');
        showPrompt();
        return;
      }
      runtime.setAllowWeb(on);
      webOn = on;
      confirmWeb = on;
      console.log(`web ${on ? 'on' : 'off'} (this session only)`);
      showPrompt();
      return;
    }

    if (result.approveAction) {
      const action = result.approveAction;
      try {
        if (action.type === 'status') {
          console.log(formatApproveStatus(prefs));
          console.log(`  prefs file: ${prefsPath(prefsAnchor)}`);
          console.log(
            `  runtime: shell:${runtime.config.allowShell ? 'on' : 'off'} web:${runtime.config.allowWeb ? 'on' : 'off'}`,
          );
        } else if (action.type === 'session') {
          runtime.permissionGate.grantSession(action.kind);
          if (action.kind === 'shell') {
            runtime.setAllowShell(true);
            shellOn = true;
          } else {
            runtime.setAllowWeb(true);
            webOn = true;
          }
          console.log(`${action.kind} approved for this session`);
        } else if (action.type === 'always') {
          prefs = mergePrefs(
            prefsAnchor,
            action.kind === 'shell'
              ? { allowShell: true, alwaysShell: true }
              : { allowWeb: true, alwaysWeb: true },
          );
          applyAlwaysFromPrefs(prefs);
          const path = prefsPath(prefsAnchor);
          const verified = loadPrefs(prefsAnchor);
          const flag = action.kind === 'shell' ? verified?.alwaysShell : verified?.alwaysWeb;
          console.log(`${action.kind} always-approved → ${path}`);
          console.log(flag ? `  ✓ persisted always${action.kind === 'shell' ? 'Shell' : 'Web'}=true` : '  ✗ persist failed — check path permissions');
        } else if (action.type === 'revoke') {
          prefs = mergePrefs(
            prefsAnchor,
            action.kind === 'shell' ? { alwaysShell: false } : { alwaysWeb: false },
          );
          applyAlwaysFromPrefs(prefs);
          console.log(`revoked always-approve for ${action.kind}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`✗ approve failed: ${msg}`);
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
        console.log('  (pi TUI: /skills opens picker; or /skills load <name>)');
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

    if (result.message === '__mcp_list__') {
      const tools = runtime.listMcpTools();
      if (tools.length === 0) {
        console.log('(no MCP tools — add mcp_servers to agent.json)');
      } else {
        const byServer = new Map<string, typeof tools>();
        for (const t of tools) {
          const list = byServer.get(t.serverName) ?? [];
          list.push(t);
          byServer.set(t.serverName, list);
        }
        for (const [server, serverTools] of byServer) {
          console.log(`  [${server}]`);
          for (const t of serverTools) {
            const desc = t.description.length > 72
              ? `${t.description.slice(0, 71)}…`
              : t.description;
            console.log(`    • ${t.apiName}  (${t.toolName})`);
            if (desc) console.log(`      ${desc}`);
          }
        }
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
      await runtime.setCwd(resolve(path));
      console.log(`cwd → ${runtime.config.cwd}`);
      showPrompt();
      return;
    }

    if (result.message === '__workflow_list__') {
      const workflows = runtime.listWorkflowMeta();
      if (workflows.length === 0) {
        console.log('(no workflows)');
      } else {
        for (const w of workflows) {
          const roles =
            w.roles.length > 0 ? `roles: ${w.roles.join(', ')}` : 'roles: (none)';
          console.log(`  • ${w.name}  (${roles})`);
        }
        console.log('  (pi TUI: /workflow opens picker; or /workflow !<name>)');
      }
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
    const trimmed = normalizeReplInput(line);

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
      prefs = mergePrefs(prefsAnchor, {
        allowShell: confirmShell,
        allowWeb: confirmWeb,
      });
      applyAlwaysFromPrefs(prefs);
      mode = 'idle';
      console.log(
        `Tools: shell:${runtime.config.allowShell ? 'on' : 'off'} web:${runtime.config.allowWeb ? 'on' : 'off'}`,
      );
      showPrompt();
      return;
    }

    if (!trimmed) {
      showPrompt();
      return;
    }

    if (mode === 'running' || mode === 'stopping') {
      if (isSlashCommand(trimmed)) {
        void handleSlash(parseSlashLine(trimmed));
        return;
      }
      console.log('Busy — /stop or Ctrl+C first');
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
      requestStop();
      return;
    }
    runtime.saveIfDirty();
    rl.close();
    void runtime.shutdown().finally(() => process.exit(0));
  });

  process.stdout.on('resize', () => resetMarkdownTerminal());

  showPrompt();
}