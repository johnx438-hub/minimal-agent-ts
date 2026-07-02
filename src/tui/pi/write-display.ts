import { pickCodeFence } from './markdown-fence.js';
import {
  parseWriteKind,
  writeStatusFromOutput,
} from '../../tools/write-display.js';

export interface WriteDisplayParts {
  path: string;
  status: 'ok' | 'error';
  kind: 'new file' | 'overwrite' | 'unknown';
  byteSize?: number;
  diffText: string;
  errorBody?: string;
}

export function parseWritePath(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    return String(args.path ?? '').trim();
  } catch {
    return '';
  }
}

export function parseWriteContentLength(argsJson: string): number {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    return Buffer.byteLength(String(args.content ?? ''), 'utf8');
  } catch {
    return 0;
  }
}

export function parseWriteByteSize(output: string): number | undefined {
  const match = output.match(/ok: wrote (\d+) bytes/);
  return match ? Number(match[1]) : undefined;
}

export function buildWriteDisplayParts(
  argsJson: string,
  output: string,
  display?: string,
): WriteDisplayParts {
  const path = parseWritePath(argsJson) || '?';
  const status = writeStatusFromOutput(output);

  if (status === 'error') {
    return {
      path,
      status,
      kind: 'unknown',
      diffText: '',
      errorBody: output.trim(),
    };
  }

  return {
    path,
    status,
    kind: parseWriteKind(output),
    byteSize: parseWriteByteSize(output),
    diffText: display?.trim() ?? '',
  };
}

export function formatWriteCallLine(argsJson: string): string {
  const path = parseWritePath(argsJson);
  const shown = path.length > 80 ? `${path.slice(0, 80)}…` : path;
  const bytes = parseWriteContentLength(argsJson);
  const sizeNote = bytes > 0 ? `, ${bytes} bytes` : '';
  return `→ write: ${shown || '?'}${sizeNote}`;
}

export function formatWriteSummaryLine(parts: WriteDisplayParts): string {
  const path = parts.path.length > 72 ? `${parts.path.slice(0, 72)}…` : parts.path;
  if (parts.status === 'error') {
    const first = (parts.errorBody ?? 'error').split('\n')[0] ?? 'error';
    const clipped = first.length > 100 ? `${first.slice(0, 100)}…` : first;
    return `← write: error, ${path} — ${clipped}`;
  }
  const bytes = parts.byteSize !== undefined ? `${parts.byteSize} bytes` : 'ok';
  const kind = parts.kind !== 'unknown' ? `, ${parts.kind}` : '';
  return `← write: ${bytes}, ${path}${kind}`;
}

export function formatWriteResultMarkdown(parts: WriteDisplayParts): string {
  const path = parts.path.replace(/`/g, '\\`');

  if (parts.status === 'error') {
    const body = parts.errorBody ?? 'error';
    const fence = pickCodeFence(body);
    return `**write** \`${path}\`\n\n${fence}text\n${body}\n${fence}`;
  }

  if (!parts.diffText) {
    return `**write** \`${path}\` (${parts.kind})\n\n_(no diff available)_`;
  }

  const fence = pickCodeFence(parts.diffText);
  return `**write** \`${path}\` (${parts.kind})\n\n${fence}diff\n${parts.diffText}\n${fence}`;
}