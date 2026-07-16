import { resolve } from 'node:path';

import type { TUI } from '@earendil-works/pi-tui';

import type { CompressionFatigueTracker } from '../compression-fatigue.js';
import type { AgentRuntime } from '../runner.js';
import { cwdChangeNeedsConfirm } from '../tools/path-utils.js';
import { executeMemorySlash } from '../workspace-memory.js';
import {
  handleLlmSlashPi,
  modelPickerItemsFromChoices,
  profilePickerItems,
  reasoningPickerItems,
} from './llm-slash.js';
import { showHistoryBrowser } from './pi/history-overlay.js';
import { showJobsBrowser, showJobStatusOverlay, showJobTailOverlay } from './pi/jobs-overlay.js';
import { showSpawnsBrowser } from './pi/spawns-overlay.js';
import { showLogBrowser } from './pi/log-overlay.js';
import { buildSelectItems, showPickerOverlay } from './pi/picker.js';
import { showSessionsBrowser } from './pi/sessions-overlay.js';
import { ui } from './i18n.js';
import {
  formatApproveStatus,
  loadPrefs,
  mergePrefs,
  prefsLocale,
  prefsPath,
  type TuiPrefs,
} from './prefs.js';
import type { SlashResult } from './slash.js';
import { formatSlashHelpLines } from './slash.js';

export interface PiSlashUiState {
  prefs: TuiPrefs;
  shellOn: boolean;
  webOn: boolean;
  confirmShell: boolean;
  confirmWeb: boolean;
  armedWorkflow: string | null;
}

export interface PiSlashHandlerDeps {
  runtime: AgentRuntime;
  tui: TUI;
  prefsAnchor: string;
  uiState: PiSlashUiState;
  fatigueTracker: CompressionFatigueTracker;
  say: (msg: string, dim?: boolean) => void;
  resumeEditor: () => void;
  requestStop: () => void;
  printStatus: () => void;
  runTask: (task: string, workflowPath?: string) => Promise<void>;
  applyAlwaysFromPrefs: (p: TuiPrefs) => void;
  confirmCwdChange: (from: string, to: string) => Promise<boolean>;
  /** Refresh autocomplete + footer hint after /lang. */
  onLocaleChange?: () => void;
}

export async function handlePiSlash(
  result: SlashResult | null,
  deps: PiSlashHandlerDeps,
): Promise<void> {
  if (!result) return;

  const {
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
    onLocaleChange,
  } = deps;

  const locale = () => prefsLocale(uiState.prefs);

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
    say('Busy — /stop or Esc (confirm) first');
    resumeEditor();
    return;
  }

  if (result.message === '__help__') {
    for (const line of formatSlashHelpLines(locale())) say(`  ${line}`, true);
    resumeEditor();
    return;
  }

  if (result.message === '__lang__' || result.message === '__lang_usage__') {
    if (result.message === '__lang_usage__') {
      say(ui(locale(), 'langUsage'));
    } else {
      say(ui(locale(), 'langStatus')(locale()));
    }
    resumeEditor();
    return;
  }

  if (result.message?.startsWith('__lang__:')) {
    const next = result.message.slice('__lang__:'.length);
    const loc = next === 'en' ? 'en' : 'zh';
    uiState.prefs = mergePrefs(prefsAnchor, { locale: loc });
    onLocaleChange?.();
    say(ui(loc, 'langSet')(loc));
    resumeEditor();
    return;
  }

  if (result.jobsAction) {
    const action = result.jobsAction;
    if (action.kind === 'list') {
      await showJobsBrowser(tui, runtime);
    } else if (action.kind === 'status') {
      await showJobStatusOverlay(tui, runtime, action.jobId);
    } else {
      await showJobTailOverlay(tui, runtime, action.jobId);
    }
    resumeEditor();
    return;
  }

  if (result.spawnsAction) {
    await showSpawnsBrowser(tui, runtime);
    resumeEditor();
    return;
  }

  if (result.llmAction) {
    await handleLlmSlashPi(runtime, result.llmAction, {
      say,
      pickProfile: async () => {
        const items = profilePickerItems(runtime);
        const picked = await showPickerOverlay(tui, {
          title: String(ui(locale(), 'profilesTitle')),
          items,
          maxVisible: Math.min(items.length, 10),
        });
        return picked?.value ?? null;
      },
      pickModel: async (choices) => {
        const items = modelPickerItemsFromChoices(
          choices,
          runtime.getEffectiveProfileName(),
        );
        const picked = await showPickerOverlay(tui, {
          title: String(ui(locale(), 'modelsTitle')),
          items,
          maxVisible: Math.min(items.length, 10),
        });
        return picked?.value ?? null;
      },
      pickReasoning: async () => {
        const items = reasoningPickerItems(runtime);
        const picked = await showPickerOverlay(tui, {
          title: String(ui(locale(), 'reasoningTitle')),
          items,
          maxVisible: Math.min(items.length, 10),
        });
        return picked?.value ?? null;
      },
    });
    printStatus();
    resumeEditor();
    return;
  }

  if (result.message === '__actions__' || result.message?.startsWith('__actions__:')) {
    const sid = result.message.startsWith('__actions__:')
      ? result.message.slice('__actions__:'.length)
      : undefined;
    const session = runtime.resolveLogSession(sid);
    if (!session) {
      say(
        sid
          ? `Session not found: ${sid}`
          : '(no active session — /resume or run a task first)',
      );
    } else {
      await showLogBrowser(tui, session);
    }
    resumeEditor();
    return;
  }

  if (result.message === '__transcript__' || result.message?.startsWith('__transcript__:')) {
    const sid = result.message.startsWith('__transcript__:')
      ? result.message.slice('__transcript__:'.length)
      : undefined;
    const session = runtime.resolveHistorySession(sid);
    if (!session) {
      say(
        sid
          ? `Session not found: ${sid}`
          : '(no active session — /resume or run a task first)',
      );
    } else {
      await showHistoryBrowser(tui, session);
    }
    resumeEditor();
    return;
  }

  if (result.message === '__sessions__') {
    const browse = await showSessionsBrowser(tui, runtime, {
      say,
      printStatus,
      locale: locale(),
    });
    if (browse.kind === 'resume') {
      if (!runtime.resumeSession(browse.sessionId)) {
        say(`Session not found: ${browse.sessionId}`);
      } else {
        uiState.armedWorkflow = null;
        runtime.armWorkflow(null);
        fatigueTracker.reset();
        say(
          `Resumed ${browse.sessionId} (${runtime.session!.tasks.length} tasks)`,
        );
        printStatus();
      }
    } else if (browse.kind === 'deleted') {
      fatigueTracker.reset();
      printStatus();
    }
    resumeEditor();
    return;
  }

  if (result.message === '__new__') {
    runtime.newSession();
    uiState.armedWorkflow = null;
    runtime.armWorkflow(null);
    fatigueTracker.reset();
    say(`New session: ${runtime.sessionLabel()}`);
    printStatus();
    resumeEditor();
    return;
  }

  if (result.newSessionBrief) {
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

  if (result.briefWrite) {
    const path = runtime.writeHandoff();
    if (!path) say('(no active session)');
    else say(`Brief written: ${path}`);
    resumeEditor();
    return;
  }

  if (result.briefLoad !== undefined) {
    const sid = result.briefLoad || undefined;
    const path = runtime.loadHandoffForNextTask(sid);
    if (!path) {
      say(
        sid ? `No brief for session ${sid}` : '(no brief file for current session)',
      );
    } else {
      say(`Brief loaded from ${path} — queued for next task`);
    }
    resumeEditor();
    return;
  }

  if (result.memoryMessage) {
    say(result.memoryMessage);
    resumeEditor();
    return;
  }

  if (result.memoryAction) {
    for (const line of executeMemorySlash(runtime.config.cwd, result.memoryAction)
      .split('\n')
      .filter((l) => l.length > 0)) {
      say(line, true);
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
    const always = uiState.prefs.alwaysShell ? ' (always in prefs)' : '';
    say(
      `shell: ${runtime.config.allowShell ? 'on' : 'off'}${always}  (/shell on|off, session-only)`,
    );
    resumeEditor();
    return;
  }

  if (result.message === '__web_status__') {
    const always = uiState.prefs.alwaysWeb ? ' (always in prefs)' : '';
    say(
      `web: ${runtime.config.allowWeb ? 'on' : 'off'}${always}  (/web on|off, session-only)`,
    );
    resumeEditor();
    return;
  }

  if (result.message?.startsWith('__shell__:')) {
    const on = result.message.endsWith('on');
    if (!on && uiState.prefs.alwaysShell) {
      say('shell is always-approved — use /approve revoke always shell');
      resumeEditor();
      return;
    }
    runtime.setAllowShell(on);
    uiState.shellOn = on;
    uiState.confirmShell = on;
    say(`shell ${on ? 'on' : 'off'} (this session only)`);
    resumeEditor();
    return;
  }

  if (result.message?.startsWith('__web__:')) {
    const on = result.message.endsWith('on');
    if (!on && uiState.prefs.alwaysWeb) {
      say('web is always-approved — use /approve revoke always web');
      resumeEditor();
      return;
    }
    runtime.setAllowWeb(on);
    uiState.webOn = on;
    uiState.confirmWeb = on;
    say(`web ${on ? 'on' : 'off'} (this session only)`);
    resumeEditor();
    return;
  }

  if (result.approveAction) {
    const action = result.approveAction;
    try {
      if (action.type === 'status') {
        say(formatApproveStatus(uiState.prefs));
        say(`  prefs file: ${prefsPath(prefsAnchor)}`, true);
        say(
          `  runtime: shell:${runtime.config.allowShell ? 'on' : 'off'} web:${runtime.config.allowWeb ? 'on' : 'off'}`,
          true,
        );
      } else if (action.type === 'session') {
        runtime.permissionGate.grantSession(action.kind);
        if (action.kind === 'shell') {
          runtime.setAllowShell(true);
          uiState.shellOn = true;
        } else {
          runtime.setAllowWeb(true);
          uiState.webOn = true;
        }
        say(`${action.kind} approved for this session`);
      } else if (action.type === 'always') {
        uiState.prefs = mergePrefs(
          prefsAnchor,
          action.kind === 'shell'
            ? { allowShell: true, alwaysShell: true }
            : { allowWeb: true, alwaysWeb: true },
        );
        applyAlwaysFromPrefs(uiState.prefs);
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
        uiState.prefs = mergePrefs(
          prefsAnchor,
          action.kind === 'shell' ? { alwaysShell: false } : { alwaysWeb: false },
        );
        applyAlwaysFromPrefs(uiState.prefs);
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
      title: String(ui(locale(), 'skillsTitle')),
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
    say('', true);
    const { buildDepProbeReport, formatDepProbeReport } = await import(
      '../deps-probe.js'
    );
    const report = buildDepProbeReport({
      ddgrPath: runtime.pluginConfig.web_search?.ddgr_path,
    });
    for (const line of formatDepProbeReport(report).split('\n')) {
      say(line, true);
    }
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

  if (result.message === '__cwd_list__') {
    say(runtime.describeWorkspace());
    resumeEditor();
    return;
  }

  if (result.message === '__cwd_primary__') {
    try {
      const primary = runtime.listWorkspaceGrants().find((g) => g.label === 'primary');
      const target = primary?.root ?? runtime.config.cwd;
      await runtime.setCwd(target, { grantIfMissing: true });
      say(`cwd → ${runtime.config.cwd} (primary)`);
    } catch (err) {
      say(err instanceof Error ? err.message : String(err));
    }
    resumeEditor();
    return;
  }

  if (result.message?.startsWith('__cwd_allow__:')) {
    const raw = result.message.slice('__cwd_allow__:'.length).trim();
    const tokens = raw.split(/\s+/).filter(Boolean);
    const flags = new Set(tokens.filter((t) => t.startsWith('--')).map((t) => t.toLowerCase()));
    const pathTok = tokens.find((t) => !t.startsWith('--'));
    if (!pathTok) {
      say('Usage: /cwd allow <path> [--ro|--rw] [--shell] [--web]');
      resumeEditor();
      return;
    }
    const mode = flags.has('--ro') || flags.has('--read-only') ? 'read_only' : 'read_write';
    try {
      const g = runtime.allowWorkspacePath({
        path: pathTok,
        mode,
        scope: 'session',
        shell: flags.has('--shell'),
        web: flags.has('--web'),
      });
      say(`granted: ${g.root} (${g.mode}${g.shell ? ', shell' : ''}${g.web ? ', web' : ''})`);
    } catch (err) {
      say(err instanceof Error ? err.message : String(err));
    }
    resumeEditor();
    return;
  }

  if (result.message?.startsWith('__cwd_revoke__:')) {
    const path = result.message.slice('__cwd_revoke__:'.length);
    const ok = runtime.revokeWorkspacePath(path);
    say(ok ? `revoked grant for ${path}` : `no grant for ${path}`);
    resumeEditor();
    return;
  }

  if (result.message?.startsWith('__cwd__:')) {
    const path = result.message.slice('__cwd__:'.length);
    const target = resolve(path);
    if (cwdChangeNeedsConfirm(runtime.config.cwd, target)) {
      const ok = await confirmCwdChange(runtime.config.cwd, target);
      if (!ok) {
        say('cwd change cancelled');
        resumeEditor();
        return;
      }
    }
    try {
      // grantIfMissing: user confirmed tree leave → session rw grant + switch
      await runtime.setCwd(target, { grantIfMissing: true, grantMode: 'read_write' });
      say(`cwd → ${runtime.config.cwd}`);
    } catch (err) {
      say(err instanceof Error ? err.message : String(err));
    }
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
      title: String(ui(locale(), 'workflowsTitle')),
      items,
      maxVisible: Math.min(items.length, 10),
    });
    if (picked) {
      const path = runtime.resolveWorkflowPath(picked.value);
      if (!path) {
        say(`Workflow not found: ${picked.value}`);
      } else {
        runtime.armWorkflow(path);
        uiState.armedWorkflow = picked.value;
        say(
          `Workflow ON: ${picked.value} — next message is the task (then auto OFF). /workflow off to cancel.`,
        );
      }
    }
    resumeEditor();
    return;
  }

  if (result.armWorkflow !== undefined) {
    const name = result.armWorkflow;
    if (name === null) {
      runtime.armWorkflow(null);
      uiState.armedWorkflow = null;
      say('Workflow OFF — normal chat');
      printStatus();
    } else {
      const path = runtime.resolveWorkflowPath(name);
      if (!path) say(`Workflow not found: ${name}`);
      else {
        runtime.armWorkflow(path);
        uiState.armedWorkflow = name;
        say(
          `Workflow ON: ${name} — next message is the task (then auto OFF). /workflow off to cancel.`,
        );
        printStatus();
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
    // One-shot run: do not leave runtime armed.
    runtime.armWorkflow(null);
    uiState.armedWorkflow = null;
    await runTask(result.runWorkflow.task, path);
    return;
  }

  if (result.message) {
    say(result.message);
    resumeEditor();
  }
}