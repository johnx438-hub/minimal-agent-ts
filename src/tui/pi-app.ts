import { resolve } from 'node:path';

import {
  CombinedAutocompleteProvider,
  Editor,
  getKeybindings,
  ProcessTerminal,
  Text,
  TUI,
} from '@earendil-works/pi-tui';

import { isActionIoMetricsEnabled } from '../action-io-metrics.js';
import { getMaxContextTokens } from '../context/budget.js';
import type { AgentRuntime } from '../runner.js';
import { CompressionFatigueTracker } from '../compression-fatigue.js';
import { TokenStatusTracker } from './pi/token-status.js';
import {
  applyVerboseEnv,
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
import { isOverlayOpen } from './pi/overlay-stack.js';
import {
  createPiAbortConfirm,
  createPiCwdChangeConfirm,
  createPiFatiguePrompter,
  createPiPermissionPrompter,
  createPiWorkflowConfirm,
  runPiFirstRunConfirm,
} from './pi/prompts.js';
import { piEditorTheme, piSemantic } from './pi/themes.js';

const SLASH_AUTOCOMPLETE = slashAutocompleteItems();

type AppMode = 'confirm' | 'idle' | 'running' | 'stopping';

export async function runPiTuiApp(opts: TuiAppOptions): Promise<void> {
  const { runtime } = opts;
  const prefsAnchor = resolvePrefsRoot(runtime.config.cwd);

  const saved = loadPrefs(prefsAnchor);
  const needsConfirm = saved === null;
  const uiState: PiSlashUiState = {
    prefs: applyVerboseEnv(saved ?? defaultPrefs()),
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
    'Enter send · Esc stop (confirm) · /help · /stop',
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

  tui.addChild(new Text(bannerLines.join('\n'), 1, 1, piSemantic.metaLine));

  const editor = new Editor(tui, piEditorTheme);
  const autocomplete = new CombinedAutocompleteProvider(
    SLASH_AUTOCOMPLETE,
    runtime.config.cwd,
  );
  editor.setAutocompleteProvider(autocomplete);
  tui.addChild(editor);
  tui.setFocus(editor);

  const chat = new PiChatLog(tui, editor);

  /** Docked footer: status + hint stay above the editor (TUI-E). */
  const statusBar = new Text('', 1, 0, piSemantic.statusBar);
  const hintLine = new Text(
    'Enter send · Esc closes panels / confirms stop · / for commands',
    1,
    0,
    piSemantic.hint,
  );
  // Insert footers before editor, then register so chat content inserts above them.
  {
    const edIdx = tui.children.indexOf(editor);
    tui.children.splice(edIdx, 0, statusBar, hintLine);
  }
  chat.setStickyFooter([statusBar, hintLine]);

  const say = (msg: string, dim = false): void => {
    chat.appendText(msg, dim);
  };

  let lastRunAborted = false;
  let lastTurn = 0;
  let lastTurnIoTag = '';
  const tokenStatus = new TokenStatusTracker();

  const resumeEditor = (): void => {
    // Keep Enter enabled — onSubmit blocks non-slash input while running.
    editor.disableSubmit = false;
    tui.setFocus(editor);
    tui.requestRender();
  };

  const printStatus = (): void => {
    tokenStatus.bindSession(runtime.sessionLabel());
    const wf = uiState.armedWorkflow ? ` · wf:${uiState.armedWorkflow}` : '';
    const runningJobs = runtime.countRunningBackgroundJobs();
    const jobsTag = runningJobs > 0 ? ` · jobs:${runningJobs}` : '';
    const ioTag = isActionIoMetricsEnabled() && lastTurnIoTag ? ` · ${lastTurnIoTag}` : '';
    const turnTag = lastTurn > 0 ? ` · turn:${lastTurn}` : '';
    const ctxLimit = getMaxContextTokens(runtime.config.model);
    const tokTag = tokenStatus.formatStatus(ctxLimit);
    const tokPart = tokTag ? ` · ${tokTag}` : '';
    const line =
      `${runtime.sessionLabel()} · ${runtime.formatSessionLlmShortLine()}` +
      ` · shell:${runtime.config.allowShell ? 'on' : 'off'}` +
      ` · web:${runtime.config.allowWeb ? 'on' : 'off'}` +
      `${jobsTag}${ioTag}${turnTag}${tokPart}${wf}`;
    statusBar.setText(line);
    tui.requestRender();
  };

  let presenter!: PiEventPresenter;
  let stopConfirmBusy = false;
  const confirmAbort = createPiAbortConfirm(tui);

  /** Immediate abort (after user confirmed, or hard path). */
  const forceStop = (): void => {
    if (!runtime.isRunning()) return;
    mode = 'stopping';
    presenter.setStopping();
    say('… stopping', true);
    runtime.abort();
    printStatus();
  };

  /**
   * Soft stop: Esc / loader / /stop → confirm panel.
   * Global Esc is ignored while any overlay is open (panel owns Esc).
   * /stop and loader always open confirm (even if another overlay was open — rare).
   */
  const requestStop = (opts?: { fromGlobalEsc?: boolean }): void => {
    void requestStopWithConfirm(opts);
  };

  const requestStopWithConfirm = async (opts?: {
    fromGlobalEsc?: boolean;
  }): Promise<void> => {
    if (!runtime.isRunning()) return;
    if (mode === 'stopping') return;
    if (stopConfirmBusy) return;
    // Esc while jobs/transcript/etc. is open: do not abort — overlay handles Esc.
    if (opts?.fromGlobalEsc && isOverlayOpen()) return;

    stopConfirmBusy = true;
    try {
      const shouldStop = await confirmAbort();
      if (shouldStop && runtime.isRunning()) {
        forceStop();
      }
    } finally {
      stopConfirmBusy = false;
    }
  };

  presenter = new PiEventPresenter({
    chat,
    tui,
    onAbort: () => requestStop(),
    getCwd: () => runtime.config.cwd,
    getDisplayPrefs: () => applyVerboseEnv(uiState.prefs),
    onTurn: (turn) => {
      lastTurn = turn;
      printStatus();
    },
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
      printStatus();
    }),
  );
  runtime.setWorkflowConfirmFn(createPiWorkflowConfirm(tui));
  const confirmCwdChange = createPiCwdChangeConfirm(tui);

  const fatigueTracker = new CompressionFatigueTracker();
  const fatiguePrompter = createPiFatiguePrompter(tui);

  printStatus();

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
      lastTurnIoTag = '';
      lastTurn = 0;
      printStatus();
    }
    if (event.type === 'spawn_start') {
      tokenStatus.onSpawnStart();
    }
    if (event.type === 'spawn_end') {
      tokenStatus.onSpawnEnd();
    }
    if (event.type === 'llm_done') {
      if (tokenStatus.onLlmDone(event.usage)) {
        printStatus();
      }
    }
    if (event.type === 'turn_io' && isActionIoMetricsEnabled()) {
      lastTurnIoTag = `io:T${event.turn} ${event.actions_saved}/${event.action_save_ms}ms q=${event.queue_depth}`;
      printStatus();
    }
    if (event.type === 'run_stopping') {
      mode = 'stopping';
      printStatus();
    }
    if (event.type === 'compression') {
      fatigueTracker.onCompression(event);
    }
    presenter.handle(event);
    if (event.type === 'run_end') {
      lastRunAborted = event.reason === 'aborted';
      printStatus();
      void finishRun();
    }
  });

  const runTask = async (task: string, workflowPath?: string): Promise<void> => {
    if (runtime.hasPendingHandoff()) {
      say('(injecting brief context)', true);
    }
    chat.appendUserMessage(task);
    uiState.armedWorkflow = null;
    printStatus();
    try {
      if (workflowPath) {
        await runtime.runWorkflowTask(task, workflowPath);
      } else {
        await runtime.runTask(task);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chat.appendText(`✗ ${msg}`, false, piSemantic.statusErr);
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
    // Overlay has focus: never steal Esc for abort (fixes jobs/transcript conflict).
    if (isOverlayOpen()) return { data };
    if (kb.matches(data, 'tui.select.cancel')) {
      requestStop({ fromGlobalEsc: true });
      return { consume: true };
    }
    // Ctrl+C while running: soft confirm (not process exit).
    if (kb.matches(data, 'tui.input.copy')) {
      requestStop({ fromGlobalEsc: true });
      return { consume: true };
    }
    return { data };
  });

  process.on('SIGINT', () => {
    if (runtime.isRunning()) {
      // Hard path: terminal SIGINT skips confirm (escape hatch).
      forceStop();
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