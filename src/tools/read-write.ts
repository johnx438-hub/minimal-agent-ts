import { readFile, writeFile } from 'node:fs/promises';

import type { AgentConfig, ToolDefinition } from '../types.js';
import { formatFileMeta } from './file-hash.js';
import { resolveSafePath, sliceLines } from './path-utils.js';

export const READ_WRITE_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file. Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
          offset: { type: 'integer', description: '1-based start line (optional)' },
          limit: { type: 'integer', description: 'Max lines to read (optional)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite a text file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

const MAX_READ_CHARS = 8000;

export async function runReadWriteTool(
  name: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  switch (name) {
    case 'read_file': {
      const path = String(args.path ?? '');
      const file = resolveSafePath(config.cwd, path);
      const raw = await readFile(file, 'utf8');
      const offset = args.offset === undefined ? undefined : Number(args.offset);
      const limit = args.limit === undefined ? undefined : Number(args.limit);
      const body = sliceLines(raw, offset, limit);
      const meta = formatFileMeta(raw);
      const truncated =
        body.length > MAX_READ_CHARS
          ? `${body.slice(0, MAX_READ_CHARS)}\n...(truncated)`
          : body;
      return truncated + meta;
    }

    case 'write_file': {
      const path = String(args.path ?? '');
      const content = String(args.content ?? '');
      const file = resolveSafePath(config.cwd, path);
      await writeFile(file, content, 'utf8');
      return `ok: wrote ${content.length} bytes to ${path}`;
    }

    default:
      return null;
  }
}