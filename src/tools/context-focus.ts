/**
 * context_focus — main-agent temporary pointerize keep boost (SPEC_POINTERIZE_SCOPE P2).
 */

import type { AgentConfig, ToolDefinition } from '../types.js';

export const CONTEXT_FOCUS_TOOL = 'context_focus';

export const CONTEXT_FOCUS_KEEP_DEFAULT = 12;
export const CONTEXT_FOCUS_KEEP_MAX = 20;
export const CONTEXT_FOCUS_TTL_DEFAULT = 8;
export const CONTEXT_FOCUS_TTL_MAX = 30;

export const CONTEXT_FOCUS_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: CONTEXT_FOCUS_TOOL,
      description:
        'Temporarily raise how long tool results stay inline before pointer cards ' +
        '(for multi-clause review / large-file cross-check). Main agent only. ' +
        'Does not disable compression under high context pressure. ' +
        'Use clear=true to cancel early. Prefer over busy recall loops.',
      parameters: {
        type: 'object',
        properties: {
          keep_inline_turns: {
            type: 'integer',
            description: `Raised keep window (default ${CONTEXT_FOCUS_KEEP_DEFAULT}, max ${CONTEXT_FOCUS_KEEP_MAX}).`,
          },
          ttl_turns: {
            type: 'integer',
            description: `How many agent turns the boost lasts (default ${CONTEXT_FOCUS_TTL_DEFAULT}, max ${CONTEXT_FOCUS_TTL_MAX}).`,
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional tool names that get the raised keep (default: all tools).',
          },
          reason: {
            type: 'string',
            description: 'Short reason for logs (e.g. multi-clause code review).',
          },
          clear: {
            type: 'boolean',
            description: 'If true, cancel any active context_focus.',
          },
        },
      },
    },
  },
];

export function runContextFocusTool(
  name: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): string | null {
  if (name !== CONTEXT_FOCUS_TOOL) return null;

  if ((config.spawnDepth ?? 0) > 0) {
    return 'error: context_focus is only available on the main agent (not inside spawn/workflow children)';
  }

  if (args.clear === true) {
    delete config.pointerizeFocus;
    return 'ok: context_focus cleared; pointerize keep window restored to policy defaults';
  }

  const keepRaw = args.keep_inline_turns;
  const keep =
    keepRaw === undefined
      ? CONTEXT_FOCUS_KEEP_DEFAULT
      : Math.min(
          CONTEXT_FOCUS_KEEP_MAX,
          Math.max(0, Math.floor(Number(keepRaw))),
        );
  if (!Number.isFinite(keep)) {
    return `error: keep_inline_turns must be a number 0..${CONTEXT_FOCUS_KEEP_MAX}`;
  }

  const ttlRaw = args.ttl_turns;
  const ttl =
    ttlRaw === undefined
      ? CONTEXT_FOCUS_TTL_DEFAULT
      : Math.min(
          CONTEXT_FOCUS_TTL_MAX,
          Math.max(1, Math.floor(Number(ttlRaw))),
        );
  if (!Number.isFinite(ttl)) {
    return `error: ttl_turns must be a number 1..${CONTEXT_FOCUS_TTL_MAX}`;
  }

  let tools: string[] | undefined;
  if (Array.isArray(args.tools)) {
    tools = args.tools
      .map((t) => String(t).trim())
      .filter(Boolean);
    if (tools.length === 0) tools = undefined;
  }

  const reason =
    typeof args.reason === 'string' && args.reason.trim()
      ? args.reason.trim().slice(0, 200)
      : undefined;

  config.pointerizeFocus = {
    keepInlineTurns: keep,
    remainingTurns: ttl,
    tools,
    reason,
  };

  const toolNote = tools?.length
    ? ` tools=[${tools.join(', ')}]`
    : ' tools=all';
  const reasonNote = reason ? ` reason=${JSON.stringify(reason)}` : '';
  return (
    `ok: context_focus active keep_inline_turns=${keep} ttl_turns=${ttl}` +
    `${toolNote}${reasonNote}. ` +
    'Large tool bodies stay inline longer; high context still forces cards.'
  );
}
