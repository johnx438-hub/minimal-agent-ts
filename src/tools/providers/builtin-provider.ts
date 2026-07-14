import { isCapabilityEnabled } from '../../permission-gate.js';
import type { AgentConfig, ToolDefinition } from '../../types.js';
import { APPLY_PATCH_DEFINITIONS, runApplyPatchTool } from '../apply-patch.js';
import { CODE_REVIEW_DEFINITIONS, runCodeReviewTool } from '../code-review.js';
import { EDIT_FILE_DEFINITIONS, runEditFileTool } from '../edit-file.js';
import { EXPLORE_DEFINITIONS, runExploreTool } from '../explore.js';
import { READ_WRITE_DEFINITIONS, runReadWriteTool } from '../read-write.js';
import { RECALL_DEFINITIONS, runRecallTool } from '../recall.js';
import { GIT_DEFINITIONS, runGitTool } from '../git.js';
import { LSP_DEFINITIONS, runLspTool } from '../lsp.js';
import { OFFICE_DEFINITIONS, runOfficeTool } from '../office.js';
import { SHELL_DEFINITIONS, runShellTool } from '../shell.js';
import { TEST_RUN_DEFINITIONS, runTestRunTool } from '../test-run.js';
import { WEB_FETCH_DEFINITIONS, runWebFetchTool } from '../web-fetch.js';
import { isRoleToolAllowlisted } from './tool-allowlist.js';
import type { ToolProvider, ToolProviderContext, ToolResolveContext } from './types.js';

type BuiltinHandler = (
  toolName: string,
  args: Record<string, unknown>,
  config: AgentConfig,
) => Promise<string | null>;

interface BuiltinToolEntry {
  defs: ToolDefinition[];
  handler: BuiltinHandler;
  requiresShell?: boolean;
  requiresWeb?: boolean;
}

const BUILTIN_TOOLS: Record<string, BuiltinToolEntry> = {
  read_file: { defs: READ_WRITE_DEFINITIONS, handler: runReadWriteTool },
  write_file: { defs: READ_WRITE_DEFINITIONS, handler: runReadWriteTool },
  edit_file: { defs: EDIT_FILE_DEFINITIONS, handler: runEditFileTool },
  apply_patch: { defs: APPLY_PATCH_DEFINITIONS, handler: runApplyPatchTool },
  grep_search: { defs: EXPLORE_DEFINITIONS, handler: runExploreTool },
  list_files: { defs: EXPLORE_DEFINITIONS, handler: runExploreTool },
  diff_file: { defs: EXPLORE_DEFINITIONS, handler: runExploreTool },
  recall_query: { defs: RECALL_DEFINITIONS, handler: runRecallTool },
  run_shell: { defs: SHELL_DEFINITIONS, handler: runShellTool, requiresShell: true },
  test_run: { defs: TEST_RUN_DEFINITIONS, handler: runTestRunTool, requiresShell: true },
  git_status: { defs: GIT_DEFINITIONS, handler: runGitTool, requiresShell: true },
  git_diff: { defs: GIT_DEFINITIONS, handler: runGitTool, requiresShell: true },
  git_log: { defs: GIT_DEFINITIONS, handler: runGitTool, requiresShell: true },
  lsp_query: { defs: LSP_DEFINITIONS, handler: runLspTool },
  office_read: { defs: OFFICE_DEFINITIONS, handler: runOfficeTool },
  office_write: { defs: OFFICE_DEFINITIONS, handler: runOfficeTool },
  web_fetch: { defs: WEB_FETCH_DEFINITIONS, handler: runWebFetchTool, requiresWeb: true },
  code_review: { defs: CODE_REVIEW_DEFINITIONS, handler: runCodeReviewTool },
};

export const BUILTIN_TOOL_NAMES = Object.keys(BUILTIN_TOOLS);

/** Default builtin_tools when agent.json omits the field. */
export const DEFAULT_BUILTIN_TOOLS = [
  ...BUILTIN_TOOL_NAMES,
  'invoke_skill',
  'web_search',
] as const;

export class BuiltinToolProvider implements ToolProvider {
  private enabledBuiltin = new Set<string>();

  async load(ctx: ToolProviderContext): Promise<void> {
    this.enabledBuiltin = new Set(
      ctx.enabledBuiltin ?? ctx.pluginConfig.builtin_tools ?? DEFAULT_BUILTIN_TOOLS,
    );
  }

  async shutdown(): Promise<void> {
    this.enabledBuiltin.clear();
  }

  getDefinitions(ctx: ToolResolveContext): ToolDefinition[] {
    const allowlist = ctx.config.toolAllowlist;
    const defs: ToolDefinition[] = [];
    const seen = new Set<string>();

    for (const toolName of this.enabledBuiltin) {
      const entry = BUILTIN_TOOLS[toolName];
      if (!entry) continue;
      if (entry.requiresShell && !isCapabilityEnabled(ctx.config, 'shell')) continue;
      if (entry.requiresWeb && !isCapabilityEnabled(ctx.config, 'web')) continue;
      if (!isRoleToolAllowlisted(toolName, allowlist)) continue;

      for (const def of entry.defs) {
        const name = def.function.name;
        if (!this.enabledBuiltin.has(name)) continue;
        if (!isRoleToolAllowlisted(name, allowlist)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        defs.push(def);
      }
    }

    return defs;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolResolveContext,
  ): Promise<string | null> {
    const entry = BUILTIN_TOOLS[name];
    if (!entry || !this.enabledBuiltin.has(name)) return null;

    if (entry.requiresShell && !isCapabilityEnabled(ctx.config, 'shell')) {
      const gate = ctx.config.permissionGate;
      if (!gate || !(await gate.ensureShell(ctx.config, name))) {
        if (ctx.config.abortSignal?.aborted) return '[aborted]';
        return `error: ${name} is disabled. Use /shell on or approve when prompted.`;
      }
    }
    if (entry.requiresWeb && !isCapabilityEnabled(ctx.config, 'web')) {
      const gate = ctx.config.permissionGate;
      if (!gate || !(await gate.ensureWeb(ctx.config, name))) {
        if (ctx.config.abortSignal?.aborted) return '[aborted]';
        return `error: ${name} is disabled. Use /web on or approve when prompted.`;
      }
    }

    return entry.handler(name, args, ctx.config);
  }

  /** Test hook: set enabled builtin tools without registry load. */
  setEnabledForTests(enabledBuiltin: Iterable<string>): void {
    this.enabledBuiltin = new Set(enabledBuiltin);
  }
}