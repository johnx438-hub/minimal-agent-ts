import { resolve } from 'node:path';

import {
  CombinedAutocompleteProvider,
  Editor,
  getKeybindings,
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
  slashAutocompleteItems,
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
import { buildSelectItems, showPickerOverlay } from './pi/picker.js';
import { showSessionDetailOverlay } from './pi/session-detail.js';
import { piEditorTheme } from './pi/themes.js';
import { formatSessionPickerDescription } from '../session.js';

const SLASH_AUTOCOMPLETE = slashAutocompleteItems();

type AppMode = 'confirm' | 'idle' | 'running' | 'stopping';

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
    `session: ${runtime.sessionLabel()}`,
    `shell:   ${shellOn ? 'on' : 'off'}   web: ${webOn ? 'on' : 'off'}`,
    'slash: /help   /stop or Esc while running',
  ];
  if (!runtime.hasActiveSession()) {
    bannerLines.push('(no session yet — /resume, /new, or first task)');
    bannerLines.push('CLI: npm run tui -- --resume <session_id>');
  }
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

  let lastRunAborted = false;

  const resumeEditor = (): void => {
    // Keep Enter enabled — onSubmit blocks non-slash input while running.
    editor.disableSubmit = false;
    tui.setFocus(editor);
    tui.requestRender();
  };

  const requestStop = (): void => {
    if (!runtime.isRunning()) return;
    mode = 'stopping';
    presenter.setStopping();
    say('… stopping', true);
    runtime.abort();
  };

  const presenter = new PiEventPresenter({
    chat,
    tui,
    onAbort: () => requestStop(),
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
      `[${runtime.sessionLabel()}] shell:${runtime.config.allowShell ? 'on' : 'off'} web:${runtime.config.allowWeb ? 'on' : 'off'}${wf}`,
      true,
    );
  };

  const finishRun = async (): Promise<void> => {
    mode = 'idle';
    if (!lastRunAborted && fatigueTracker.shouldPrompt()) {
      const choice = await fatiguePrompter(fatigueTracker.stats());
      fatigueTracker.snooze();
      if (choice === 'handoff') {
        const handoff = runtime.newSessionWithHandoff();
        if (!handoff) {
          say('(no active session — nothing to hand off)');
        } else {
          const { path, fromSessionId } = handoff;
          armedWorkflow = null;
          runtime.armWorkflow(null);
          fatigueTracker.reset();
          say(`Handoff from ${fromSessionId} → ${path}`);
          say(`New session: ${runtime.sessionLabel()} (handoff queued)`);
          printStatus();
        }
      } else if (choice === 'clear') {
        if (!runtime.clearCurrentContext()) {
          say('(no active session)');
        } else {
          say('Context cleared (completed task summaries kept)');
        }
      }
    }
    resumeEditor();
  };

  runtime.onEvent((event) => {
    if (event.type === 'run_start') {
      mode = 'running';
      lastRunAborted = false;
    }
    if (event.type === 'run_stopping') {
      mode = 'stopping';
    }
    if (event.type === 'compression') {
      fatigueTracker.onCompression(
        event.turn,
        (event.pruned ?? 0) + (event.pointer_compacted ?? 0),
      );
    }
    presenter.handle(event);
    if (event.type === 'run_end') {
      lastRunAborted = event.reason === 'aborted';
      void finishRun();
    }
  });

  const runTask = async (task: string, workflowPath?: string): Promise<void> => {
    if (runtime.hasPendingHandoff()) {
      say('(injecting handoff context)', true);
    }
    chat.appendMarkdown(`**›** ${task}`);
    armedWorkflow = null;
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
        requestStop();
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
      if (sessions.length === 0) {
        say('(no sessions)');
        resumeEditor();
        return;
      }

      const currentId = runtime.sessionLabel();
      const items = buildSelectItems(
        sessions.map((s) => {
          const current = s.session_id === currentId ? ' (current)' : '';
          return {
            value: s.session_id,
            label: `${s.session_id}${current}`,
            description: formatSessionPickerDescription(s),
          };
        }),
      );

      const picked = await showPickerOverlay(tui, {
        title: 'Sessions — Enter resume · i info · Esc cancel',
        items,
        maxVisible: Math.min(items.length, 10),
        onInfo: async (item, finish) => {
          const overview = runtime.getSessionOverview(item.value);
          if (!overview) {
            say(`Session not found: ${item.value}`);
            return;
          }
          const action = await showSessionDetailOverlay(tui, overview);
          if (action === 'resume') finish(item);
        },
      });
      if (!picked) {
        resumeEditor();
        return;
      }
      if (!runtime.resumeSession(picked.value)) {
        say(`Session not found: ${picked.value}`);
      } else {
        armedWorkflow = null;
        runtime.armWorkflow(null);
        fatigueTracker.reset();
        say(
          `Resumed ${picked.value} (${runtime.session!.tasks.length} tasks)`,
        );
        printStatus();
      }
      resumeEditor();
      return;
    }

    if (result.message === '__new__') {
      runtime.newSession();
      armedWorkflow = null;
      runtime.armWorkflow(null);
      fatigueTracker.reset();
      say(`New session: ${runtime.sessionLabel()}`);
      printStatus();
      resumeEditor();
      return;
    }

    if (result.newSessionHandoff) {
      const handoff = runtime.newSessionWithHandoff();
      if (!handoff) {
        say('(no active session — nothing to hand off)');
      } else {
        const { path, fromSessionId } = handoff;
        armedWorkflow = null;
        runtime.armWorkflow(null);
        fatigueTracker.reset();
        say(`Handoff from ${fromSessionId} → ${path}`);
        say(`New session: ${runtime.sessionLabel()} (handoff queued)`);
        printStatus();
      }
      resumeEditor();
      return;
    }

    if (result.clearContext) {
      if (!runtime.clearCurrentContext()) {
        say('(no active session)');
      } else {
        fatigueTracker.reset();
        say('Context cleared (task summaries kept)');
      }
      resumeEditor();
      return;
    }

    if (result.handoffWrite) {
      const path = runtime.writeHandoff();
      if (!path) say('(no active session)');
      else say(`Handoff written: ${path}`);
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
        say(
          `Resumed active session ${runtime.sessionLabel()} (${runtime.session!.tasks.length} tasks)`,
        );
        printStatus();
      }
      resumeEditor();
      return;
    }

    if (result.message?.startsWith('__resume__')) {
      const id = result.message.slice('__resume__:'.length);
      if (!runtime.resumeSession(id)) say(`Session not found: ${id}`);
      else {
        say(`Resumed ${id} (${runtime.session!.tasks.length} tasks)`);
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
      if (skills.length === 0) {
        say('(no skills)');
        resumeEditor();
        return;
      }

      const loaded = new Set(runtime.getLoadedSkills());
      const items = buildSelectItems(
        skills.map((s) => ({
          value: s.name,
          label: loaded.has(s.name) ? `${s.name} (loaded)` : s.name,
          description: s.description.slice(0, 72),
        })),
      );

      const picked = await showPickerOverlay(tui, {
        title: 'Skills — Enter to load · Esc cancel',
        items,
        maxVisible: Math.min(items.length, 10),
      });
      if (picked) {
        runtime.loadSkill(picked.value);
        say(`Loaded skill: ${picked.value} (next task)`);
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

    if (result.message === '__mcp_list__') {
      const tools = runtime.listMcpTools();
      if (tools.length === 0) {
        say('(no MCP tools — add mcp_servers to agent.json)');
      } else {
        const byServer = new Map<string, typeof tools>();
        for (const t of tools) {
          const list = byServer.get(t.serverName) ?? [];
          list.push(t);
          byServer.set(t.serverName, list);
        }
        for (const [server, serverTools] of byServer) {
          say(`  [${server}]`, true);
          for (const t of serverTools) {
            const desc = t.description.length > 72
              ? `${t.description.slice(0, 71)}…`
              : t.description;
            say(`    • ${t.apiName}  (${t.toolName})`, true);
            if (desc) say(`      ${desc}`, true);
          }
        }
      }
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
      await runtime.setCwd(resolve(path));
      say(`cwd → ${runtime.config.cwd}`);
      resumeEditor();
      return;
    }

    if (result.message === '__workflow_list__') {
      const workflows = runtime.listWorkflowMeta();
      if (workflows.length === 0) {
        say('(no workflows)');
        resumeEditor();
        return;
      }

      const armed = runtime.getArmedWorkflow();
      const armedName = armed
        ? workflows.find((w) => runtime.resolveWorkflowPath(w.name) === armed)?.name
        : undefined;

      const items = buildSelectItems(
        workflows.map((w) => {
          const roles =
            w.roles.length > 0 ? `roles: ${w.roles.join(', ')}` : 'roles: (none)';
          const share = w.shareSession ? ' · shared session' : '';
          const current = armedName === w.name ? ' (armed)' : '';
          return {
            value: w.name,
            label: `${w.name}${current}`,
            description: `${roles}${share}`,
          };
        }),
      );

      const picked = await showPickerOverlay(tui, {
        title: 'Workflows — Enter to arm · Esc cancel',
        items,
        maxVisible: Math.min(items.length, 10),
      });
      if (picked) {
        const path = runtime.resolveWorkflowPath(picked.value);
        if (!path) {
          say(`Workflow not found: ${picked.value}`);
        } else {
          runtime.armWorkflow(path);
          armedWorkflow = picked.value;
          say(`Armed workflow: ${picked.value} — next line is the task`);
        }
      }
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
    const trimmed = normalizeReplInput(value);
    if (!trimmed) {
      resumeEditor();
      return;
    }

    if (mode === 'running' || mode === 'stopping') {
      if (isSlashCommand(trimmed)) {
        void handleSlash(parseSlashLine(trimmed));
        return;
      }
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

  const kb = getKeybindings();
  tui.addInputListener((data) => {
    if (mode !== 'running' && mode !== 'stopping') return { data };
    if (kb.matches(data, 'tui.select.cancel')) {
      requestStop();
      return { consume: true };
    }
    if (kb.matches(data, 'tui.input.copy')) {
      requestStop();
      return { consume: true };
    }
    return { data };
  });

  process.on('SIGINT', () => {
    if (runtime.isRunning()) {
      requestStop();
      return;
    }
    runtime.saveIfDirty();
    tui.stop();
    void runtime.shutdown().finally(() => process.exit(0));
  });

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