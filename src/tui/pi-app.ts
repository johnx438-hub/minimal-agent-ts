import { resolve } from 'node:path';

import {
  CombinedAutocompleteProvider,
  Editor,
  ProcessTerminal,
  Text,
  TUI,
} from '@earendil-works/pi-tui';

import type { AgentRuntime } from '../runner.js';
import { CompressionFatigueTracker } from '../compression-fatigue.js';
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
import type { TuiAppOptions } from './app.js';
import { PiChatLog } from './pi/chat-log.js';
import { PiEventPresenter } from './pi/event-presenter.js';
import {
  createPiFatiguePrompter,
  createPiPermissionPrompter,
  createPiWorkflowConfirm,
  runPiFirstRunConfirm,
} from './pi/prompts.js';
import { piEditorTheme } from './pi/themes.js';

const SLASH_AUTOCOMPLETE = SLASH_HELP_LINES.map((line) => {
  const trimmed = line.trim();
  const space = trimmed.indexOf(' ');
  const cmd = space === -1 ? trimmed : trimmed.slice(0, space);
  const name = cmd.replace(/^\//, '');
  const description = space === -1 ? '' : trimmed.slice(space + 1).trim();
  return { name, description };
});

type AppMode = 'confirm' | 'idle' | 'running';

export async function runPiTuiApp(opts: TuiAppOptions): Promise<void> {
  const { runtime } = opts;
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

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const bannerLines = [
    'minimal-agent-ts TUI  (pi presenter)',
    `model:   ${runtime.config.model}`,
    `cwd:     ${runtime.config.cwd}`,
    `session: ${runtime.session.session_id}`,
    `shell:   ${shellOn ? 'on' : 'off'}   web: ${webOn ? 'on' : 'off'}`,
    'slash: /help   Esc aborts while running',
  ];
  if (runtime.hasPendingHandoff()) {
    bannerLines.push('(handoff loaded — will inject on next task)');
  }
  if (prefs.alwaysShell || prefs.alwaysWeb) {
    const always: string[] = [];
    if (prefs.alwaysShell) always.push('shell');
    if (prefs.alwaysWeb) always.push('web');
    bannerLines.push(`⚠ always-approve: ${always.join(', ')}`);
  }

  tui.addChild(new Text(bannerLines.join('\n'), 1, 1));

  const editor = new Editor(tui, piEditorTheme);
  const autocomplete = new CombinedAutocompleteProvider(
    SLASH_AUTOCOMPLETE,
    runtime.config.cwd,
  );
  editor.setAutocompleteProvider(autocomplete);
  tui.addChild(editor);
  tui.setFocus(editor);

  const chat = new PiChatLog(tui, editor);

  const say = (msg: string, dim = false): void => {
    chat.appendText(msg, dim);
  };

  const resumeEditor = (): void => {
    editor.disableSubmit = mode === 'running';
    tui.setFocus(editor);
    tui.requestRender();
  };

  const presenter = new PiEventPresenter({
    chat,
    tui,
    onAbort: () => runtime.abort(),
  });

  runtime.permissionGate.setPrompter(
    createPiPermissionPrompter(tui, (kind) => {
      if (kind === 'shell') {
        runtime.setAllowShell(true);
        shellOn = true;
      } else {
        runtime.setAllowWeb(true);
        webOn = true;
      }
    }),
  );
  runtime.setWorkflowConfirmFn(createPiWorkflowConfirm(tui));

  const fatigueTracker = new CompressionFatigueTracker();
  const fatiguePrompter = createPiFatiguePrompter(tui);

  const printStatus = (): void => {
    const wf = armedWorkflow ? `  workflow armed: ${armedWorkflow}` : '';
    say(
      `[${runtime.session.session_id}] shell:${runtime.config.allowShell ? 'on' : 'off'} web:${runtime.config.allowWeb ? 'on' : 'off'}${wf}`,
      true,
    );
  };

  const finishRun = async (): Promise<void> => {
    mode = 'idle';
    if (fatigueTracker.shouldPrompt()) {
      const choice = await fatiguePrompter(fatigueTracker.stats());
      fatigueTracker.snooze();
      if (choice === 'handoff') {
        const { path, fromSessionId } = runtime.newSessionWithHandoff();
        armedWorkflow = null;
        runtime.armWorkflow(null);
        fatigueTracker.reset();
        say(`Handoff from ${fromSessionId} → ${path}`);
        say(`New session: ${runtime.session.session_id} (handoff queued)`);
        printStatus();
      } else if (choice === 'clear') {
        runtime.clearCurrentContext();
        say('Context cleared (completed task summaries kept)');
      }
    }
    resumeEditor();
  };

  runtime.onEvent((event) => {
    if (event.type === 'run_start') {
      mode = 'running';
      editor.disableSubmit = true;
    }
    if (event.type === 'compression') {
      fatigueTracker.onCompression(event.turn, event.pruned ?? 0);
    }
    presenter.handle(event);
    if (event.type === 'run_end') {
      void finishRun();
    }
  });

  const runTask = async (task: string, workflowPath?: string): Promise<void> => {
    if (runtime.hasPendingHandoff()) {
      say('(injecting handoff context)', true);
    }
    chat.appendMarkdown(`**›** ${task}`);
    armedWorkflow = null;
    editor.disableSubmit = true;
    try {
      if (workflowPath) {
        await runtime.runWorkflowTask(task, workflowPath);
      } else {
        await runtime.runTask(task);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      say(`✗ ${msg}`);
      mode = 'idle';
      resumeEditor();
    }
  };

  const handleSlash = async (result: ReturnType<typeof parseSlashLine>): Promise<void> => {
    if (!result) return;

    if (result.stop) {
      if (runtime.isRunning()) {
        say('… stopping');
        runtime.abort();
      } else {
        say('(not running)');
      }
      resumeEditor();
      return;
    }

    if (result.quit) {
      runtime.saveIfDirty();
      tui.stop();
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
      say('Busy — /stop or Esc first');
      resumeEditor();
      return;
    }

    if (result.message === '__help__') {
      for (const line of SLASH_HELP_LINES) say(`  ${line}`, true);
      resumeEditor();
      return;
    }

    if (result.message === '__sessions__') {
      const sessions = runtime.listSessions().slice(0, 20);
      if (sessions.length === 0) say('(no sessions)');
      else {
        for (const s of sessions) {
          say(
            `  ${s.session_id}  tasks=${s.task_count}  ${new Date(s.created_at).toISOString().slice(0, 16)}`,
            true,
          );
        }
      }
      resumeEditor();
      return;
    }

    if (result.message === '__new__') {
      runtime.newSession();
      armedWorkflow = null;
      runtime.armWorkflow(null);
      fatigueTracker.reset();
      say(`New session: ${runtime.session.session_id}`);
      printStatus();
      resumeEditor();
      return;
    }

    if (result.newSessionHandoff) {
      const { path, fromSessionId } = runtime.newSessionWithHandoff();
      armedWorkflow = null;
      runtime.armWorkflow(null);
      fatigueTracker.reset();
      say(`Handoff from ${fromSessionId} → ${path}`);
      say(`New session: ${runtime.session.session_id} (handoff queued)`);
      printStatus();
      resumeEditor();
      return;
    }

    if (result.clearContext) {
      runtime.clearCurrentContext();
      fatigueTracker.reset();
      say('Context cleared (task summaries kept)');
      resumeEditor();
      return;
    }

    if (result.handoffWrite) {
      const path = runtime.writeHandoff();
      say(`Handoff written: ${path}`);
      resumeEditor();
      return;
    }

    if (result.handoffLoad !== undefined) {
      const sid = result.handoffLoad || undefined;
      const path = runtime.loadHandoffForNextTask(sid);
      if (!path) {
        say(
          sid ? `No handoff for session ${sid}` : '(no handoff file for current session)',
        );
      } else {
        say(`Handoff loaded from ${path} — queued for next task`);
      }
      resumeEditor();
      return;
    }

    if (result.message === '__resume_last__') {
      if (!runtime.resumeLatestSession()) say('(no saved sessions)');
      else {
        say(`Resumed latest ${runtime.session.session_id} (${runtime.session.tasks.length} tasks)`);
        printStatus();
      }
      resumeEditor();
      return;
    }

    if (result.message?.startsWith('__resume__')) {
      const id = result.message.slice('__resume__:'.length);
      if (!runtime.resumeSession(id)) say(`Session not found: ${id}`);
      else {
        say(`Resumed ${id} (${runtime.session.tasks.length} tasks)`);
        printStatus();
      }
      resumeEditor();
      return;
    }

    if (result.message === '__shell_status__') {
      const always = prefs.alwaysShell ? ' (always in prefs)' : '';
      say(
        `shell: ${runtime.config.allowShell ? 'on' : 'off'}${always}  (/shell on|off, session-only)`,
      );
      resumeEditor();
      return;
    }

    if (result.message === '__web_status__') {
      const always = prefs.alwaysWeb ? ' (always in prefs)' : '';
      say(
        `web: ${runtime.config.allowWeb ? 'on' : 'off'}${always}  (/web on|off, session-only)`,
      );
      resumeEditor();
      return;
    }

    if (result.message?.startsWith('__shell__:')) {
      const on = result.message.endsWith('on');
      if (!on && prefs.alwaysShell) {
        say('shell is always-approved — use /approve revoke always shell');
        resumeEditor();
        return;
      }
      runtime.setAllowShell(on);
      shellOn = on;
      confirmShell = on;
      say(`shell ${on ? 'on' : 'off'} (this session only)`);
      resumeEditor();
      return;
    }

    if (result.message?.startsWith('__web__:')) {
      const on = result.message.endsWith('on');
      if (!on && prefs.alwaysWeb) {
        say('web is always-approved — use /approve revoke always web');
        resumeEditor();
        return;
      }
      runtime.setAllowWeb(on);
      webOn = on;
      confirmWeb = on;
      say(`web ${on ? 'on' : 'off'} (this session only)`);
      resumeEditor();
      return;
    }

    if (result.approveAction) {
      const action = result.approveAction;
      try {
        if (action.type === 'status') {
          say(formatApproveStatus(prefs));
          say(`  prefs file: ${prefsPath(prefsAnchor)}`, true);
          say(
            `  runtime: shell:${runtime.config.allowShell ? 'on' : 'off'} web:${runtime.config.allowWeb ? 'on' : 'off'}`,
            true,
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
          say(`${action.kind} approved for this session`);
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
          say(`${action.kind} always-approved → ${path}`);
          say(
            flag
              ? `  ✓ persisted always${action.kind === 'shell' ? 'Shell' : 'Web'}=true`
              : '  ✗ persist failed — check path permissions',
          );
        } else if (action.type === 'revoke') {
          prefs = mergePrefs(
            prefsAnchor,
            action.kind === 'shell' ? { alwaysShell: false } : { alwaysWeb: false },
          );
          applyAlwaysFromPrefs(prefs);
          say(`revoked always-approve for ${action.kind}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        say(`✗ approve failed: ${msg}`);
      }
      resumeEditor();
      return;
    }

    if (result.message === '__skills__') {
      const skills = runtime.listSkills();
      if (skills.length === 0) say('(no skills)');
      else {
        for (const s of skills) {
          say(`  ${s.name}: ${s.description.slice(0, 72)}`, true);
        }
      }
      resumeEditor();
      return;
    }

    if (result.message?.startsWith('__skill_load__:')) {
      const name = result.message.slice('__skill_load__:'.length);
      runtime.loadSkill(name);
      say(`Loaded skill: ${name} (next task)`);
      resumeEditor();
      return;
    }

    if (result.message === '__tools__') {
      for (const t of runtime.listToolNames()) say(`  • ${t}`, true);
      resumeEditor();
      return;
    }

    if (result.message === '__spawns__') {
      const presets = runtime.listSpawnPresets();
      if (presets.length === 0) {
        say('(no spawn presets — add spawn_presets to agent.json)');
      } else {
        for (const p of presets) {
          say(`  • ${p.name}: ${p.description}`, true);
          say(`    tools: ${p.tools.join(', ')}`, true);
        }
      }
      resumeEditor();
      return;
    }

    if (result.message?.startsWith('__cwd__:')) {
      const path = result.message.slice('__cwd__:'.length);
      runtime.setCwd(resolve(path));
      say(`cwd → ${runtime.config.cwd}`);
      resumeEditor();
      return;
    }

    if (result.message === '__workflow_list__') {
      const wfs = runtime.listWorkflows();
      if (wfs.length === 0) say('(no workflows)');
      else for (const w of wfs) say(`  • ${w}`, true);
      resumeEditor();
      return;
    }

    if (result.armWorkflow !== undefined) {
      const name = result.armWorkflow;
      if (name === null) {
        runtime.armWorkflow(null);
        armedWorkflow = null;
        say('Workflow disarmed');
      } else {
        const path = runtime.resolveWorkflowPath(name);
        if (!path) say(`Workflow not found: ${name}`);
        else {
          runtime.armWorkflow(path);
          armedWorkflow = name;
          say(`Armed workflow: ${name} — next line is the task`);
        }
      }
      resumeEditor();
      return;
    }

    if (result.runWorkflow) {
      const path = runtime.resolveWorkflowPath(result.runWorkflow.path);
      if (!path) {
        say(`Workflow not found: ${result.runWorkflow.path}`);
        resumeEditor();
        return;
      }
      await runTask(result.runWorkflow.task, path);
      return;
    }

    if (result.message) {
      say(result.message);
      resumeEditor();
    }
  };

  editor.onSubmit = (value: string) => {
    if (mode === 'running') return;

    const trimmed = normalizeReplInput(value);
    if (!trimmed) {
      resumeEditor();
      return;
    }

    if (mode === 'confirm') {
      if (isSlashCommand(trimmed)) {
        void handleSlash(parseSlashLine(trimmed));
        return;
      }
      say('Use the first-run overlay to confirm tools (or /help)');
      resumeEditor();
      return;
    }

    if (isSlashCommand(trimmed)) {
      void handleSlash(parseSlashLine(trimmed));
      return;
    }

    const workflowPath = armedWorkflow
      ? runtime.resolveWorkflowPath(armedWorkflow) ?? undefined
      : undefined;
    void runTask(trimmed, workflowPath);
  };

  tui.start();

  if (needsConfirm) {
    await runPiFirstRunConfirm(
      tui,
      () => confirmShell,
      () => confirmWeb,
      () => {
        confirmShell = !confirmShell;
      },
      () => {
        confirmWeb = !confirmWeb;
      },
    );
    prefs = mergePrefs(prefsAnchor, {
      allowShell: confirmShell,
      allowWeb: confirmWeb,
    });
    applyAlwaysFromPrefs(prefs);
    mode = 'idle';
    say(
      `Tools: shell:${runtime.config.allowShell ? 'on' : 'off'} web:${runtime.config.allowWeb ? 'on' : 'off'}`,
    );
  }

  await new Promise<void>(() => {
    // pi TUI owns the process until exit (/quit or fatal error)
  });
}