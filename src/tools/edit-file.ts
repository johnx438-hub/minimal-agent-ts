import { readFile, writeFile } from 'node:fs/promises';

import type { AgentConfig, ToolDefinition } from '../types.js';
import { formatEditToolResult } from './edit-display.js';
import { hashFileContent } from './file-hash.js';
import { resolveWritablePath } from './path-utils.js';

export const EDIT_FILE_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Apply a anchored edit to a text file. Prefer over write_file for partial changes. Use expected_hash from read_file [file_meta] to detect stale files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          expected_hash: {
            type: 'string',
            description: 'file_meta hash from read_file; rejects edit if file changed',
          },
          old_string: {
            type: 'string',
            description: 'Exact text to replace (must be unique unless replace_all)',
          },
          new_string: {
            type: 'string',
            description: 'Replacement text for old_string mode',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace every old_string occurrence (default false)',
          },
          start_line: {
            type: 'integer',
            description: '1-based start line for line-range mode (inclusive)',
          },
          end_line: {
            type: 'integer',
            description: '1-based end line for line-range mode (inclusive)',
          },
          new_content: {
            type: 'string',
            description: 'Replacement lines for line-range mode',
          },
        },
        required: ['path'],
      },
    },
  },
];

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

export async function runEditFileTool(
  name: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  if (name !== 'edit_file') return null;

  const path = String(args.path ?? '').trim();
  if (!path) return 'error: path is required';

  let file: string;
  try {
    file = resolveWritablePath(config.cwd, path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `error: ${msg}`;
  }

  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `error: cannot read ${path}: ${msg}`;
  }

  const currentHash = hashFileContent(content);
  const expectedHash =
    args.expected_hash !== undefined ? String(args.expected_hash).trim() : '';
  if (expectedHash && expectedHash !== currentHash) {
    return [
      `error: stale file (hash mismatch)`,
      `expected=${expectedHash}`,
      `current=${currentHash}`,
      `hint=read_file("${path}") then retry with updated expected_hash`,
    ].join('\n');
  }

  const hasSearch = args.old_string !== undefined;
  const hasLine = args.start_line !== undefined;

  if (hasSearch && hasLine) {
    return 'error: use either old_string+new_string or start_line+end_line+new_content, not both';
  }

  let oldSnippet = '';
  let newSnippet = '';
  let editMode: 'search_replace' | 'line_range' = 'search_replace';

  if (hasSearch) {
    const oldString = String(args.old_string);
    const newString = String(args.new_string ?? '');
    const replaceAll = args.replace_all === true;

    if (!oldString) return 'error: old_string must not be empty';

    const matches = countOccurrences(content, oldString);
    if (matches === 0) {
      return `error: old_string not found in ${path}`;
    }
    if (matches > 1 && !replaceAll) {
      return `error: old_string matches ${matches} times; narrow the snippet or set replace_all=true`;
    }

    oldSnippet = oldString;
    newSnippet = newString;
    editMode = 'search_replace';

    content = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
  } else if (hasLine) {
    const startLine = Number(args.start_line);
    const endLine = Number(args.end_line ?? args.start_line);
    const newBlock = String(args.new_content ?? '');

    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
      return 'error: start_line and end_line must be numbers';
    }
    if (startLine < 1 || endLine < startLine) {
      return 'error: invalid line range';
    }

    const lines = content.split('\n');
    if (startLine > lines.length) {
      return `error: start_line ${startLine} exceeds file length (${lines.length} lines)`;
    }

    const startIdx = startLine - 1;
    const endIdx = Math.min(endLine, lines.length) - 1;
    const replacement = newBlock.split('\n');
    oldSnippet = lines.slice(startIdx, endIdx + 1).join('\n');
    newSnippet = newBlock;
    editMode = 'line_range';

    content = [...lines.slice(0, startIdx), ...replacement, ...lines.slice(endIdx + 1)].join(
      '\n',
    );
  } else {
    return 'error: provide old_string+new_string or start_line+end_line+new_content';
  }

  await writeFile(file, content, 'utf8');
  const newHash = hashFileContent(content);
  const byteSize = Buffer.byteLength(content, 'utf8');

  return formatEditToolResult(path, byteSize, newHash, oldSnippet, newSnippet, editMode);
}