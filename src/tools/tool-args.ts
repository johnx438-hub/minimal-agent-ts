const WRITE_JSON_HINT =
  'Retry with content_b64 (preferred for HTML/large quoted text), split into smaller writes, or use run_shell heredoc if shell is allowed.';

const EDIT_JSON_HINT =
  'Retry with old_string_b64/new_string_b64 (or new_content_b64), narrower snippets, or write_file with content_b64 for full rewrites.';

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

export function parseToolArgsJson(argsJson: string, toolName?: string): ParseToolArgsResult {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: formatInvalidToolArgsError(argsJson, toolName) };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: formatInvalidToolArgsError(argsJson, toolName) };
  }
}

function formatInvalidToolArgsError(argsJson: string, toolName?: string): string {
  const label = toolName ? ` for ${toolName}` : '';
  const lines = [`error: invalid JSON arguments${label}.`];
  if (toolName === 'write_file') {
    lines.push(WRITE_JSON_HINT);
  } else if (toolName === 'edit_file') {
    lines.push(EDIT_JSON_HINT);
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