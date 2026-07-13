/**
 * C2: lsp_query — structured code intelligence for agents.
 * v1: TypeScript/JS via in-process LanguageService (no external server required).
 */

import { isAbsolute, resolve } from 'node:path';

import type { AgentConfig, ToolDefinition } from '../types.js';
import { resolveReadablePath } from './path-utils.js';
import {
  formatLspQueryMarkdown,
  isTypeScriptLikePath,
  runTypeScriptLspQuery,
  type LspOperation,
} from './lsp-typescript.js';

const OPS = new Set<LspOperation>(['hover', 'definition', 'references', 'symbols']);

export const LSP_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'lsp_query',
      description:
        'Code intelligence: hover, go-to-definition, find-references, or document symbols. ' +
        'v1 supports TypeScript/JavaScript via the TypeScript language service (no shell needed). ' +
        'Prefer over blind grep when resolving symbols. path is workspace-relative; line is 1-based.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path under the working directory (or readable via path JIT).',
          },
          line: {
            type: 'number',
            description: '1-based line number for the cursor position.',
          },
          character: {
            type: 'number',
            description: '1-based column (character offset on the line). Default 1.',
          },
          operation: {
            type: 'string',
            description: "One of: hover | definition | references | symbols",
            enum: ['hover', 'definition', 'references', 'symbols'],
          },
        },
        required: ['path', 'line', 'operation'],
      },
    },
  },
];

function parseOperation(raw: unknown): LspOperation | { error: string } {
  const op = String(raw ?? '').trim().toLowerCase() as LspOperation;
  if (!OPS.has(op)) {
    return {
      error: `error: invalid operation "${String(raw)}". Use hover | definition | references | symbols`,
    };
  }
  return op;
}

export async function runLspTool(
  toolName: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  if (toolName !== 'lsp_query') return null;

  if (config.abortSignal?.aborted) return '[aborted]';

  const pathArg = String(args.path ?? '').trim();
  if (!pathArg) return 'error: path is required';

  const operation = parseOperation(args.operation);
  if (typeof operation === 'object') return operation.error;

  const line = Number(args.line);
  if (!Number.isFinite(line) || line < 1) {
    return 'error: line must be a 1-based number';
  }
  const characterRaw = args.character === undefined ? 1 : Number(args.character);
  if (!Number.isFinite(characterRaw) || characterRaw < 1) {
    return 'error: character must be a 1-based number';
  }
  const character = Math.floor(characterRaw);

  let absPath: string;
  try {
    absPath = await resolveReadablePath(
      config,
      pathArg,
      `lsp_query ${operation} ${pathArg}`,
    );
  } catch (err) {
    if (config.abortSignal?.aborted) return '[aborted]';
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  // symbols can use line 1 char 1 as document-level
  const queryLine = operation === 'symbols' ? Math.max(1, Math.floor(line)) : Math.floor(line);

  if (!isTypeScriptLikePath(absPath)) {
    return (
      `error: no language service for ${pathArg}. ` +
      'v1 lsp_query supports .ts/.tsx/.js/.jsx (and mts/cts/mjs/cjs). ' +
      'Install a mapped LSP server later for other languages.'
    );
  }

  if (config.abortSignal?.aborted) return '[aborted]';

  const result = runTypeScriptLspQuery({
    cwd: resolve(config.cwd),
    path: isAbsolute(absPath) ? absPath : resolve(config.cwd, absPath),
    line: queryLine,
    character,
    operation,
  });

  if ('error' in result) return result.error;
  return formatLspQueryMarkdown(result);
}
