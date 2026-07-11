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
  loadPrefs,
  mergePrefs,
  normalizePrefs,
  resolvePrefsRoot,
} from './prefs.js';
import {
  isSlashCommand,
  normalizeReplInput,
  parseSlashLine,
  slashAutocompleteItems,
} from './slash.js';
import { handlePiSlash, type PiSlashUiState } from './slash-handlers.js';
import type { TuiAppOptions } from './types.js';
import { PiChatLog } from './pi/chat-log.js';
import { PiEventPresenter } from './pi/event-presenter.js';
import {
  createPiCwdChangeConfirm,
  createPiFatiguePrompter,
  createPiPermissionPrompter,
  createPiWorkflowConfirm,
  runPiFirstRunConfirm,
} from './pi/prompts.js';
import { piEditorTheme } from './pi/themes.js';

const SLASH_AUTOCOMPLETE = slashAutocompleteItems();

type AppMode = 'confirm' | 'idle' | 'running' | 'stopping';

export async function runPiTuiApp(opts: TuiAppOptions): Promise<void> {
  const { runtime } = opts;
  const prefsAnchor = resolvePrefsRoot(runtime.config.cwd);

  const saved = loadPrefs(prefsAnchor);
  const needsConfirm = saved === null;
  const uiState: PiSlashUiState = {
    prefs: saved ?? defaultPrefs(),
    shellOn: false,
    webOn: false,
    confirmShell: false,
    confirmWeb: false,
    armedWorkflow: null,
  };

  uiState.shellOn = uiState.prefs.allowShell;
  uiState.webOn = uiState.prefs.allowWeb;

  if (uiState.prefs.alwaysShell && !opts.noShell) uiState.shellOn = true;
  if (uiState.prefs.alwaysWeb && !opts.noWeb) uiState.webOn = true;
  if (opts.noShell) uiState.shellOn = false;
  if (opts.noWeb) uiState.webOn = false;
  if (opts.allowWeb) uiState.webOn = true;

  runtime.setAllowShell(uiState.shellOn);
  runtime.setAllowWeb(uiState.webOn);

  let mode: AppMode = needsConfirm ? 'confirm' : 'idle';
  uiState.confirmShell = uiState.shellOn;
  uiState.confirmWeb = uiState.webOn;

  const applyAlwaysFromPrefs = (p: typeof uiState.prefs): void => {
    const normalized = normalizePrefs(p);
    runtime.permissionGate.setAlwaysGrants({
      shell: Boolean(normalized.alwaysShell),
      web: Boolean(normalized.alwaysWeb),
    });
    if (normalized.alwaysShell) {
      runtime.setAllowShell(true);
      uiState.shellOn = true;
      uiState.confirmShell = true;
    }
    if (normalized.alwaysWeb) {
      runtime.setAllowWeb(true);
      uiState.webOn = true;
      uiState.confirmWeb = true;
    }
  };

  applyAlwaysFromPrefs(uiState.prefs);

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const bannerLines = [
    'minimal-agent-ts TUI  (pi presenter)',
    `model:   ${runtime.config.model}`,
    `cwd:     ${runtime.config.cwd}`,
    `session: ${runtime.sessionLabel()}`,
    `shell:   ${uiState.shellOn ? 'on' : 'off'}   web: ${uiState.webOn ? 'on' : 'off'}`,
    'slash: /help   /stop or Esc while running',
  ];
  if (!runtime.hasActiveSession()) {
    bannerLines.push('(no session yet — /resume, /new, or first task)');
    bannerLines.push('CLI: npm run tui -- --resume <session_id>');
  }
  if (runtime.hasPendingHandoff()) {
    bannerLines.push('(brief queued — will inject on next task)');
  }
  if (uiState.prefs.alwaysShell || uiState.prefs.alwaysWeb) {
    const always: string[] = [];
    if (uiState.prefs.alwaysShell) always.push('shell');
    if (uiState.prefs.alwaysWeb) always.push('web');
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
        uiState.shellOn = true;
      } else {
        runtime.setAllowWeb(true);
        uiState.webOn = true;
      }
    }),
  );
  runtime.setWorkflowConfirmFn(createPiWorkflowConfirm(tui));
  const confirmCwdChange = createPiCwdChangeConfirm(tui);

  const fatigueTracker = new CompressionFatigueTracker();
  const fatiguePrompter = createPiFatiguePrompter(tui);

  const printStatus = (): void => {
    const wf = uiState.armedWorkflow ? `  workflow armed: ${uiState.armedWorkflow}` : '';
    say(
      `[${runtime.sessionLabel()}] ${runtime.formatSessionLlmShortLine()}  shell:${runtime.config.allowShell ? 'on' : 'off'} web:${runtime.config.allowWeb ? 'on' : 'off'}${wf}`,
      true,
    );
  };

  const finishRun = async (): Promise<void> => {
    mode = 'idle';
    if (!lastRunAborted && fatigueTracker.shouldPrompt()) {
      const choice = await fatiguePrompter(fatigueTracker.stats());
      fatigueTracker.snooze();
      if (choice === 'brief') {
        const brief = runtime.newSessionWithHandoff();
        if (!brief) {
          say('(no active session — nothing to brief)');
        } else {
          const { path, fromSessionId } = brief;
          uiState.armedWorkflow = null;
          runtime.armWorkflow(null);
          fatigueTracker.reset();
          say(`Brief from ${fromSessionId} → ${path}`);
          say(`New session: ${runtime.sessionLabel()} (brief queued)`);
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
      say('(injecting brief context)', true);
    }
    chat.appendMarkdown(`**›** ${task}`);
    uiState.armedWorkflow = null;
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

  const slashDeps = {
    runtime,
    tui,
    prefsAnchor,
    uiState,
    fatigueTracker,
    say,
    resumeEditor,
    requestStop,
    printStatus,
    runTask,
    applyAlwaysFromPrefs,
    confirmCwdChange,
  };

  const handleSlash = (result: ReturnType<typeof parseSlashLine>): void => {
    void handlePiSlash(result, slashDeps);
  };

  editor.onSubmit = (value: string) => {
    const trimmed = normalizeReplInput(value);
    if (!trimmed) {
      resumeEditor();
      return;
    }

    if (mode === 'running' || mode === 'stopping') {
      if (isSlashCommand(trimmed)) {
        handleSlash(parseSlashLine(trimmed));
        return;
      }
      resumeEditor();
      return;
    }

    if (mode === 'confirm') {
      if (isSlashCommand(trimmed)) {
        handleSlash(parseSlashLine(trimmed));
        return;
      }
      say('Use the first-run overlay to confirm tools (or /help)');
      resumeEditor();
      return;
    }

    if (isSlashCommand(trimmed)) {
      handleSlash(parseSlashLine(trimmed));
      return;
    }

    const workflowPath = uiState.armedWorkflow
      ? runtime.resolveWorkflowPath(uiState.armedWorkflow) ?? undefined
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
      () => uiState.confirmShell,
      () => uiState.confirmWeb,
      () => {
        uiState.confirmShell = !uiState.confirmShell;
      },
      () => {
        uiState.confirmWeb = !uiState.confirmWeb;
      },
    );
    uiState.prefs = mergePrefs(prefsAnchor, {
      allowShell: uiState.confirmShell,
      allowWeb: uiState.confirmWeb,
    });
    applyAlwaysFromPrefs(uiState.prefs);
    mode = 'idle';
    say(
      `Tools: shell:${runtime.config.allowShell ? 'on' : 'off'} web:${runtime.config.allowWeb ? 'on' : 'off'}`,
    );
  }

  await new Promise<void>(() => {
    // pi TUI owns the process until exit (/quit or fatal error)
  });
}