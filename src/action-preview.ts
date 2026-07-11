import { stripFileMeta } from './tools/file-hash.js';
import { decodeShellCommand } from './tools/tool-args.js';
import type { ActionBlock } from './types.js';

export type PreviewMode = 'generic' | 'smart';

export interface PreviewPolicy {
  preview_min_chars: number;
  preview_max_chars: number;
  preview_ratio: number;
  preview_mode: PreviewMode;
  preview_max_lines: number;
  summary_max_chars: number;
}

export const DEFAULT_PREVIEW_POLICY: PreviewPolicy = {
  preview_min_chars: 120,
  preview_max_chars: 480,
  preview_ratio: 0.04,
  preview_mode: 'smart',
  preview_max_lines: 5,
  summary_max_chars: 120,
};

export function previewPolicyFromPointerize(
  policy?: Partial<PreviewPolicy> & { keep_inline_turns?: number },
): PreviewPolicy {
  return {
    preview_min_chars: policy?.preview_min_chars ?? DEFAULT_PREVIEW_POLICY.preview_min_chars,
    preview_max_chars: policy?.preview_max_chars ?? DEFAULT_PREVIEW_POLICY.preview_max_chars,
    preview_ratio: policy?.preview_ratio ?? DEFAULT_PREVIEW_POLICY.preview_ratio,
    preview_mode: policy?.preview_mode ?? DEFAULT_PREVIEW_POLICY.preview_mode,
    preview_max_lines: policy?.preview_max_lines ?? DEFAULT_PREVIEW_POLICY.preview_max_lines,
    summary_max_chars: policy?.summary_max_chars ?? DEFAULT_PREVIEW_POLICY.summary_max_chars,
  };
}

export function resolvePreviewBudget(byteSize: number, policy: PreviewPolicy): number {
  const scaled = Math.floor(byteSize * policy.preview_ratio);
  return Math.min(policy.preview_max_chars, Math.max(policy.preview_min_chars, scaled));
}

function truncateLine(line: string, maxLen: number): string {
  const one = line.replace(/\s+/g, ' ').trim();
  if (one.length <= maxLen) return one;
  return `${one.slice(0, maxLen)}…`;
}

function nonEmptyLines(text: string, maxLines: number): string[] {
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed.trim()) continue;
    lines.push(trimmed);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function parseArgsJson(argsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Step 1 (A): ratio-based head/tail excerpt. */
/** One-line preview for live tool_result events (before ActionBlock exists). */
export function formatLiveToolPreview(
  toolName: string,
  _argsJson: string,
  output: string,
  policy: PreviewPolicy = DEFAULT_PREVIEW_POLICY,
): string {
  const flat = output.replace(/\r\n/g, '\n').trim();
  const max = Math.min(400, policy.preview_max_chars);
  if (flat.length <= max) {
    return flat.replace(/\n/g, '\\n');
  }
  if (toolName === 'grep_search' && flat.startsWith('(no matches)')) {
    return flat;
  }
  const head = flat.slice(0, Math.ceil(max * 0.75)).replace(/\n/g, '\\n');
  return `${head}…`;
}

export function buildGenericPreview(
  text: string,
  byteSize: number,
  policy: PreviewPolicy,
): { summary?: string; preview_lines: string[] } {
  const budget = resolvePreviewBudget(byteSize, policy);
  const flat = text.replace(/\r\n/g, '\n').trim();
  if (!flat) {
    return { preview_lines: ['(empty)'] };
  }

  if (flat.length <= budget) {
    return { preview_lines: nonEmptyLines(flat, policy.preview_max_lines) };
  }

  const headBudget = Math.ceil(budget * 0.65);
  const tailBudget = Math.max(40, budget - headBudget - 30);
  const head = truncateLine(flat.slice(0, headBudget), headBudget);
  const tail = truncateLine(flat.slice(-tailBudget), tailBudget);
  const omitted = flat.length - headBudget - tailBudget;

  return {
    summary: `excerpt head+tail (${flat.length} chars, ~${omitted} omitted)`,
    preview_lines: [head, `…[${omitted} chars omitted]…`, tail],
  };
}

function isMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp_');
}

function isSmartTool(toolName: string): boolean {
  return (
    toolName === 'grep_search' ||
    toolName === 'read_file' ||
    toolName === 'run_shell' ||
    toolName === 'web_fetch' ||
    toolName === 'web_search' ||
    isMcpTool(toolName)
  );
}

function clipSummary(text: string, policy: PreviewPolicy): string {
  return truncateLine(text, policy.summary_max_chars);
}

/** Step 2 (B): tool-aware one-line summary + sample lines. */
export function buildSmartToolPreview(
  block: ActionBlock,
  policy: PreviewPolicy,
): { summary?: string; preview_lines: string[] } | null {
  const text = block.result_text;
  const args = parseArgsJson(block.args_json);

  switch (block.tool_name) {
    case 'grep_search': {
      if (text.trim() === '(no matches)') {
        return {
          summary: clipSummary(`grep: no matches for "${String(args.pattern ?? '')}"`, policy),
          preview_lines: ['(no matches)'],
        };
      }
      const lines = nonEmptyLines(text, 200);
      const sample = lines.slice(0, policy.preview_max_lines).map((l) => truncateLine(l, 100));
      const pattern = String(args.pattern ?? '');
      const path = args.path !== undefined ? String(args.path) : '.';
      return {
        summary: clipSummary(
          `grep: ${lines.length} line(s), pattern="${pattern}", path=${path}`,
          policy,
        ),
        preview_lines: sample,
      };
    }

    case 'read_file': {
      const path = String(args.path ?? block.files_touched[0] ?? '?');
      const offset = args.offset !== undefined ? Number(args.offset) : undefined;
      const lines = nonEmptyLines(stripFileMeta(text), policy.preview_max_lines);
      const offsetNote = offset !== undefined ? `, offset=${offset}` : '';
      return {
        summary: clipSummary(
          `read_file: ${path}, ${block.line_count} lines${offsetNote}`,
          policy,
        ),
        preview_lines: lines.map((l) => truncateLine(l, 100)),
      };
    }

    case 'edit_file': {
      const path = String(args.path ?? block.files_touched[0] ?? '?');
      const mode = args.old_string !== undefined ? 'search_replace' : 'line_range';
      const hashMatch = text.match(/file_hash=([a-f0-9]+)/);
      return {
        summary: clipSummary(
          `edit_file: ${path} (${mode})${hashMatch ? ` hash=${hashMatch[1]}` : ''}`,
          policy,
        ),
        preview_lines: [truncateLine(text, 100)],
      };
    }

    case 'web_search': {
      const query = String(args.query ?? '?');
      const source = text.match(/\[source: (\w+)\]/)?.[1] ?? 'search';
      const lines = nonEmptyLines(text, policy.preview_max_lines);
      return {
        summary: clipSummary(`web_search: "${query}" (${source})`, policy),
        preview_lines: lines.slice(0, policy.preview_max_lines).map((l) => truncateLine(l, 100)),
      };
    }

    case 'web_fetch': {
      const url = String(args.url ?? '?');
      const spillMeta = text.match(/^\[web_spill[^\]]+\]/m)?.[0] ?? '';
      if (spillMeta) {
        const spillUrl = spillMeta.match(/\burl=(\S+)/)?.[1] ?? url;
        const saved = text.match(/^saved=(.+)$/m)?.[1]?.trim();
        const lines = nonEmptyLines(text, policy.preview_max_lines);
        return {
          summary: clipSummary(
            `web_fetch spill: ${spillUrl}${saved ? ` → ${saved}` : ''}`,
            policy,
          ),
          preview_lines: lines
            .slice(0, policy.preview_max_lines)
            .map((l) => truncateLine(l, 100)),
        };
      }
      const meta = text.match(/^\[web_meta[^\]]+\]/m)?.[0] ?? '';
      const via = meta.includes('via=cloak') ? 'cloak' : 'http';
      const title = text.match(/^#\s+(.+)/m)?.[1]?.trim();
      const lines = nonEmptyLines(text, policy.preview_max_lines);
      return {
        summary: clipSummary(
          `web_fetch: ${url}${title ? ` — ${title}` : ''} (${via})`,
          policy,
        ),
        preview_lines: lines.slice(0, policy.preview_max_lines).map((l) => truncateLine(l, 100)),
      };
    }

    case 'run_shell': {
      const decoded = decodeShellCommand(args);
      const command = truncateLine(decoded.ok ? decoded.command : String(args.command ?? ''), 80);
      const errMatch = text.match(/^error: exit (\d+)/m);
      const timeoutMatch = text.match(/^error: command timed out/m);
      const meta = text.match(/^\[shell:[^\]]+\]/m)?.[0];
      const body = meta ? text.slice(text.indexOf('\n') + 1).trim() : text;
      const lines = nonEmptyLines(body, policy.preview_max_lines);
      let status = 'ok';
      if (timeoutMatch) status = 'timeout';
      else if (errMatch) status = `exit ${errMatch[1]}`;
      else if (text.startsWith('error:')) status = 'error';

      return {
        summary: clipSummary(`shell: ${status}, cmd="${command}"`, policy),
        preview_lines: lines.map((l) => truncateLine(l, 100)),
      };
    }

    default: {
      if (!isMcpTool(block.tool_name)) return null;
      const headings = nonEmptyLines(text, 50).filter((l) => /^#{1,3}\s/.test(l.trim())).slice(0, 3);
      const lines = nonEmptyLines(text, policy.preview_max_lines);
      const title = headings[0]?.replace(/^#+\s*/, '') ?? truncateLine(lines[0] ?? '', 80);
      return {
        summary: clipSummary(
          `mcp ${block.tool_name}: ${block.line_count} lines, head="${title}"`,
          policy,
        ),
        preview_lines: lines.map((l) => truncateLine(l, 100)),
      };
    }
  }
}

export function buildActionPreview(
  block: ActionBlock,
  policy: PreviewPolicy = DEFAULT_PREVIEW_POLICY,
): { summary?: string; preview_lines: string[] } {
  if (policy.preview_mode === 'smart' && isSmartTool(block.tool_name)) {
    const smart = buildSmartToolPreview(block, policy);
    if (smart) return smart;
  }
  return buildGenericPreview(block.result_text, block.byte_size, policy);
}

export function attachActionPreview(
  block: ActionBlock,
  policy: PreviewPolicy = DEFAULT_PREVIEW_POLICY,
): ActionBlock {
  if (block.preview_summary && block.preview_lines?.length) {
    return block;
  }
  const built = buildActionPreview(block, policy);
  block.preview_summary = built.summary;
  block.preview_lines = built.preview_lines;
  return block;
}