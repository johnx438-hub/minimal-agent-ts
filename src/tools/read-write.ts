import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import type { AgentConfig, ToolDefinition } from '../types.js';
import { formatFileMeta } from './file-hash.js';
import { resolveReadablePath, resolveWritablePath, sliceLines } from './path-utils.js';
import { formatWriteToolResult } from './write-display.js';

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
      let file: string;
      try {
        file = await resolveReadablePath(config, path, `read_file: ${path}`);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return '[aborted]';
        }
        const msg = err instanceof Error ? err.message : String(err);
        return `error: ${msg}`;
      }
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
      let file: string;
      try {
        file = resolveWritablePath(config.cwd, path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `error: ${msg}`;
      }

      let previous: string | null = null;
      try {
        previous = await readFile(file, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          const msg = err instanceof Error ? err.message : String(err);
          return `error: cannot read ${path}: ${msg}`;
        }
      }

      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
      const byteSize = Buffer.byteLength(content, 'utf8');
      return formatWriteToolResult(path, byteSize, previous, content);
    }

    default:
      return null;
  }
}