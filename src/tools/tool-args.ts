const WRITE_JSON_HINT =
  'Retry with content_b64 (preferred for HTML/large quoted text), split into smaller writes, or use run_shell heredoc if shell is allowed.';

const ARGS_PREVIEW_MAX = 240;

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
  }
  lines.push(`Preview: ${previewArgs(argsJson)}`);
  return lines.join('\n');
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type DecodeWriteContentResult =
  | { ok: true; content: string; source: 'content' | 'content_b64' }
  | { ok: false; error: string };

export function decodeWriteFileContent(args: Record<string, unknown>): DecodeWriteContentResult {
  const b64Raw = args.content_b64;
  const hasB64 = typeof b64Raw === 'string' && b64Raw.trim().length > 0;

  if (hasB64) {
    const trimmed = String(b64Raw).replace(/\s+/g, '');
    if (!B64_RE.test(trimmed)) {
      return { ok: false, error: 'error: invalid content_b64 (not valid base64)' };
    }
    const content = Buffer.from(trimmed, 'base64').toString('utf8');
    return { ok: true, content, source: 'content_b64' };
  }

  if (args.content !== undefined && args.content !== null) {
    return { ok: true, content: String(args.content), source: 'content' };
  }

  return { ok: false, error: 'error: write_file requires content or content_b64' };
}