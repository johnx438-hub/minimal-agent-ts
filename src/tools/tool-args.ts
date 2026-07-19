import type { ToolCall } from '../types.js';

const WRITE_JSON_HINT =
  'Retry with content_b64 (preferred for HTML/large quoted text), split into smaller writes, or use run_shell heredoc if shell is allowed.';

const EDIT_JSON_HINT =
  'Retry with old_string_b64/new_string_b64 (or new_content_b64), narrower snippets, or write_file with content_b64 for full rewrites.';

const SHELL_JSON_HINT =
  'Retry with command_b64 (preferred for commands with quotes/backslashes), or simplify quoting.';

const ARGS_PREVIEW_MAX = 240;

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function previewArgs(argsJson: string): string {
  const flat = argsJson.replace(/\s+/g, ' ').trim();
  if (flat.length <= ARGS_PREVIEW_MAX) return flat;
  return `${flat.slice(0, ARGS_PREVIEW_MAX)}…`;
}

export type ParseToolArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/** Fast check for OpenAI/xAI tool_call argument strings (must be valid JSON object). */
export function isToolArgsJsonValid(argsJson: string): boolean {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

export function parseToolArgsJson(argsJson: string, toolName?: string): ParseToolArgsResult {
  if (!isToolArgsJsonValid(argsJson)) {
    return { ok: false, error: formatInvalidToolArgsError(argsJson, toolName) };
  }
  return { ok: true, args: JSON.parse(argsJson) as Record<string, unknown> };
}

export function partitionToolCallsByValidJson(
  calls: ToolCall[],
): { valid: ToolCall[]; invalid: ToolCall[] } {
  const valid: ToolCall[] = [];
  const invalid: ToolCall[] = [];
  for (const call of calls) {
    if (isToolArgsJsonValid(call.function.arguments)) {
      valid.push(call);
    } else {
      invalid.push(call);
    }
  }
  return { valid, invalid };
}

/** Leading line of {@link buildMalformedToolCallNudge} — UI/history must not show as a human bubble. */
export const MALFORMED_TOOL_ARGS_NUDGE_PREFIX =
  'Your previous tool call arguments were invalid JSON';

/** True for harness → model retry injects (LLM-only; never a real user message). */
export function isMalformedToolArgsNudge(content: string): boolean {
  return content.trimStart().startsWith(MALFORMED_TOOL_ARGS_NUDGE_PREFIX);
}

export function buildMalformedToolCallNudge(invalid: ToolCall[]): string {
  const lines = [
    `${MALFORMED_TOOL_ARGS_NUDGE_PREFIX} (often from unescaped quotes in shell commands, git args, or large HTML).`,
    'Retry with the base64 field variants where available (command_b64 / content_b64 / …).',
  ];
  for (const call of invalid) {
    const name = call.function.name;
    const hint =
      name === 'write_file'
        ? WRITE_JSON_HINT
        : name === 'edit_file'
          ? EDIT_JSON_HINT
          : name === 'run_shell' ||
              name === 'git_status' ||
              name === 'git_diff' ||
              name === 'git_log'
            ? SHELL_JSON_HINT
            : 'Ensure arguments are valid JSON.';
    lines.push(`- ${name}: ${hint}`);
    lines.push(`  Preview: ${previewArgs(call.function.arguments)}`);
  }
  return lines.join('\n');
}

function formatInvalidToolArgsError(argsJson: string, toolName?: string): string {
  const label = toolName ? ` for ${toolName}` : '';
  const lines = [`error: invalid JSON arguments${label}.`];
  if (toolName === 'write_file') {
    lines.push(WRITE_JSON_HINT);
  } else if (toolName === 'edit_file') {
    lines.push(EDIT_JSON_HINT);
  } else if (toolName === 'run_shell') {
    lines.push(SHELL_JSON_HINT);
  }
  lines.push(`Preview: ${previewArgs(argsJson)}`);
  return lines.join('\n');
}

function decodeBase64Utf8(
  raw: string,
  fieldName: string,
): { ok: true; text: string } | { ok: false; error: string } {
  const trimmed = raw.replace(/\s+/g, '');
  if (!trimmed) {
    return { ok: false, error: `error: ${fieldName} must not be empty` };
  }
  if (!B64_RE.test(trimmed)) {
    return { ok: false, error: `error: invalid ${fieldName} (not valid base64)` };
  }
  return { ok: true, text: Buffer.from(trimmed, 'base64').toString('utf8') };
}

function decodePlainOrB64Field(
  args: Record<string, unknown>,
  plainKey: string,
  b64Key: string,
): { ok: true; defined: boolean; value: string } | { ok: false; error: string } {
  const b64Raw = args[b64Key];
  if (typeof b64Raw === 'string' && b64Raw.trim().length > 0) {
    const decoded = decodeBase64Utf8(String(b64Raw), b64Key);
    if (!decoded.ok) return decoded;
    return { ok: true, defined: true, value: decoded.text };
  }
  if (args[plainKey] !== undefined && args[plainKey] !== null) {
    return { ok: true, defined: true, value: String(args[plainKey]) };
  }
  return { ok: true, defined: false, value: '' };
}

export type DecodeWriteContentResult =
  | { ok: true; content: string; source: 'content' | 'content_b64' }
  | { ok: false; error: string };

export function decodeWriteFileContent(args: Record<string, unknown>): DecodeWriteContentResult {
  const decoded = decodePlainOrB64Field(args, 'content', 'content_b64');
  if (!decoded.ok) return decoded;
  if (!decoded.defined) {
    return { ok: false, error: 'error: write_file requires content or content_b64' };
  }
  const source = typeof args.content_b64 === 'string' && args.content_b64.trim() ? 'content_b64' : 'content';
  return { ok: true, content: decoded.value, source };
}

export type ResolvedEditFileStrings = {
  old_string?: string;
  new_string?: string;
  new_content?: string;
  hasSearch: boolean;
  hasLine: boolean;
};

export type DecodeShellCommandResult =
  | { ok: true; command: string; source: 'command' | 'command_b64' }
  | { ok: false; error: string };

/** Resolve the shell command string from tool-call args JSON (plain or command_b64). */
export function resolveShellCommandFromArgsJson(argsJson: string): string {
  if (!isToolArgsJsonValid(argsJson)) return '';
  const args = JSON.parse(argsJson) as Record<string, unknown>;
  const decoded = decodeShellCommand(args);
  return decoded.ok ? decoded.command : '';
}

export function decodeShellCommand(args: Record<string, unknown>): DecodeShellCommandResult {
  const decoded = decodePlainOrB64Field(args, 'command', 'command_b64');
  if (!decoded.ok) return decoded;
  if (!decoded.defined) {
    return { ok: false, error: 'error: run_shell requires command or command_b64' };
  }
  const trimmed = decoded.value.trim();
  if (!trimmed) {
    return { ok: false, error: 'error: command is required' };
  }
  const source =
    typeof args.command_b64 === 'string' && args.command_b64.trim() ? 'command_b64' : 'command';
  return { ok: true, command: trimmed, source };
}

export function resolveEditFileStringFields(
  args: Record<string, unknown>,
): { ok: true; fields: ResolvedEditFileStrings } | { ok: false; error: string } {
  const old = decodePlainOrB64Field(args, 'old_string', 'old_string_b64');
  if (!old.ok) return old;
  const newStr = decodePlainOrB64Field(args, 'new_string', 'new_string_b64');
  if (!newStr.ok) return newStr;
  const newContent = decodePlainOrB64Field(args, 'new_content', 'new_content_b64');
  if (!newContent.ok) return newContent;

  const hasSearch = old.defined;
  const hasLine = args.start_line !== undefined;

  return {
    ok: true,
    fields: {
      hasSearch,
      hasLine,
      old_string: old.defined ? old.value : undefined,
      new_string: newStr.defined ? newStr.value : undefined,
      new_content: newContent.defined ? newContent.value : undefined,
    },
  };
}