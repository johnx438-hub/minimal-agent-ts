/**
 * Optional host dependency probe for /tools, --list-tools, and packaging docs.
 * Pure readout — does not install anything.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type DepTier = 'required' | 'recommended' | 'optional' | 'dev_only';

export interface HostDepStatus {
  id: string;
  tier: DepTier;
  label: string;
  /** What needs this dep */
  usedBy: string[];
  /** true when probe finds a usable binary / runtime */
  available: boolean;
  detail: string;
}

export interface DepProbeReport {
  node: string;
  platform: string;
  host: HostDepStatus[];
  /** npm packages that ship with this project (always present after npm i) */
  bundled: Array<{ id: string; usedBy: string[] }>;
}

function probePathCommand(command: string, args: string[] = ['--version']): {
  ok: boolean;
  detail: string;
} {
  try {
    const result = spawnSync(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 4_000,
      windowsHide: true,
      encoding: 'utf8',
    });
    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return { ok: false, detail: 'not found on PATH' };
      }
      return { ok: false, detail: err.message };
    }
    if (result.status !== 0 && result.status !== null) {
      // Some tools return non-zero for --version; still "found" if spawned.
      const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 80);
      return {
        ok: true,
        detail: out || `exit ${result.status} (present)`,
      };
    }
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n')[0] ?? '';
    return { ok: true, detail: out.slice(0, 100) || 'ok' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg };
  }
}

function probeGit(): HostDepStatus {
  const p = probePathCommand('git', ['--version']);
  return {
    id: 'git',
    tier: 'recommended',
    label: 'git CLI',
    usedBy: ['git_status', 'git_diff', 'git_log', 'code_review'],
    available: p.ok,
    detail: p.detail,
  };
}

function probeDdgr(ddgrPath = 'ddgr'): HostDepStatus {
  const p = probePathCommand(ddgrPath, ['--version']);
  // ddgr may not support --version; try -h
  const fallback = p.ok ? p : probePathCommand(ddgrPath, ['-h']);
  return {
    id: 'ddgr',
    tier: 'optional',
    label: 'ddgr (DuckDuckGo CLI)',
    usedBy: ['web_search'],
    available: fallback.ok,
    detail: fallback.detail,
  };
}

function probePython(): HostDepStatus {
  const candidates = ['python3', 'python'];
  for (const cmd of candidates) {
    const p = probePathCommand(cmd, ['--version']);
    if (p.ok) {
      return {
        id: 'python',
        tier: 'optional',
        label: 'Python 3',
        usedBy: ['web_fetch cloak L2 (optional)'],
        available: true,
        detail: `${cmd}: ${p.detail}`,
      };
    }
  }
  return {
    id: 'python',
    tier: 'optional',
    label: 'Python 3',
    usedBy: ['web_fetch cloak L2 (optional)'],
    available: false,
    detail: 'not found (cloak_fetch disabled by default)',
  };
}

function probeShell(): HostDepStatus {
  const envShell = process.env.MINIMAL_SHELL?.trim() || process.env.SHELL?.trim();
  if (envShell && existsSync(envShell)) {
    return {
      id: 'shell',
      tier: 'recommended',
      label: 'user shell',
      usedBy: ['run_shell', 'test_run'],
      available: true,
      detail: envShell,
    };
  }
  if (process.platform === 'win32') {
    const p = probePathCommand('cmd.exe', ['/c', 'echo', 'ok']);
    return {
      id: 'shell',
      tier: 'recommended',
      label: 'user shell',
      usedBy: ['run_shell', 'test_run'],
      available: p.ok,
      detail: p.ok ? 'cmd.exe' : p.detail,
    };
  }
  for (const cmd of ['/bin/bash', '/bin/sh', 'bash', 'sh']) {
    if (cmd.startsWith('/') && existsSync(cmd)) {
      return {
        id: 'shell',
        tier: 'recommended',
        label: 'user shell',
        usedBy: ['run_shell', 'test_run'],
        available: true,
        detail: cmd,
      };
    }
    const p = probePathCommand(cmd, ['-c', 'echo ok']);
    if (p.ok) {
      return {
        id: 'shell',
        tier: 'recommended',
        label: 'user shell',
        usedBy: ['run_shell', 'test_run'],
        available: true,
        detail: cmd,
      };
    }
  }
  return {
    id: 'shell',
    tier: 'recommended',
    label: 'user shell',
    usedBy: ['run_shell', 'test_run'],
    available: false,
    detail: 'no bash/sh/cmd found',
  };
}

function probeCloakHints(): HostDepStatus {
  const envScript = process.env.CLOAK_FETCH_SCRIPT?.trim();
  const candidates = [
    envScript,
    resolve(homedir(), '.claude/skills/cloak-fetch/cloak_fetch.sh'),
    resolve(homedir(), 'github/cloakFetch/skills/cloak-fetch/cloak_fetch.sh'),
    resolve(process.cwd(), 'skills/cloak-fetch/cloak_fetch.py'),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (existsSync(path)) {
      return {
        id: 'cloak_fetch',
        tier: 'optional',
        label: 'cloak_fetch script',
        usedBy: ['web_fetch L2 anti-bot fallback'],
        available: true,
        detail: path,
      };
    }
  }
  return {
    id: 'cloak_fetch',
    tier: 'optional',
    label: 'cloak_fetch script',
    usedBy: ['web_fetch L2 anti-bot fallback'],
    available: false,
    detail: 'not installed (default: cloak_fetch_enabled=false)',
  };
}

/** Static map of npm packages that ship with the agent (after npm install). */
export const BUNDLED_NPM_DEPS: Array<{ id: string; usedBy: string[] }> = [
  { id: '@earendil-works/pi-tui', usedBy: ['TUI'] },
  { id: '@modelcontextprotocol/sdk', usedBy: ['MCP tools'] },
  { id: '@mozilla/readability + linkedom + turndown', usedBy: ['web_fetch'] },
  { id: 'chalk', usedBy: ['TUI colors'] },
  { id: 'dotenv', usedBy: ['env load'] },
  { id: 'mammoth + docx', usedBy: ['office_read/write docx'] },
  { id: 'exceljs', usedBy: ['office_read/write xlsx'] },
  { id: 'pptxgenjs + jszip', usedBy: ['office_read/write pptx'] },
  { id: 'typescript (dev)', usedBy: ['lsp_query LanguageService', 'typecheck'] },
];

export interface ProbeHostDepsOptions {
  /** From agent.json web_search.ddgr_path */
  ddgrPath?: string;
}

/** Probe host binaries / runtimes (not npm tree). */
export function probeHostDeps(opts?: ProbeHostDepsOptions): HostDepStatus[] {
  return [
    {
      id: 'node',
      tier: 'required',
      label: 'Node.js',
      usedBy: ['entire runtime'],
      available: true,
      detail: process.version,
    },
    probeShell(),
    probeGit(),
    probeDdgr(opts?.ddgrPath ?? 'ddgr'),
    probePython(),
    probeCloakHints(),
  ];
}

export function buildDepProbeReport(opts?: ProbeHostDepsOptions): DepProbeReport {
  return {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    host: probeHostDeps(opts),
    bundled: BUNDLED_NPM_DEPS,
  };
}

/** Human-readable block for CLI / TUI. */
export function formatDepProbeReport(report: DepProbeReport): string {
  const lines: string[] = [
    `Runtime: Node ${report.node} · ${report.platform}`,
    '',
    'Host dependencies:',
  ];
  for (const d of report.host) {
    const mark = d.available ? '✓' : '·';
    const tier = d.tier === 'required' ? 'req' : d.tier === 'recommended' ? 'rec' : 'opt';
    lines.push(
      `  ${mark} [${tier}] ${d.label} — ${d.available ? d.detail : d.detail}`,
    );
    lines.push(`      used by: ${d.usedBy.join(', ')}`);
  }
  lines.push('', 'Bundled via npm (after install):');
  for (const b of report.bundled) {
    lines.push(`  • ${b.id} → ${b.usedBy.join(', ')}`);
  }
  lines.push(
    '',
    'Legend: ✓ available · · missing  |  req=required rec=recommended opt=optional',
    'Missing optional deps only disable their tools; core agent still runs.',
  );
  return lines.join('\n');
}
