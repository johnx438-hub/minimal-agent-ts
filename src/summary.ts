/**
 * Parse Agent-supplemented fields from final answer.
 * Extracts JSON summary appended at the end of Agent's response.
 */
export interface AgentSummaryFields {
  pending_tasks: string[];
  current_work: string;
}

const DEFAULT_SUMMARY: AgentSummaryFields = {
  pending_tasks: [],
  current_work: '',
};

/**
 * Locate trailing agent summary JSON (brace-balanced).
 * Handles ```json fences and multiline current_work — the old $ regex missed those
 * and left raw JSON visible in Web pending cards.
 */
function findPendingSummaryTail(
  finalAnswer: string,
): { start: number; end: number; object: string } | null {
  const text = finalAnswer ?? '';
  if (!text.trim()) return null;

  const re = /\{\s*["']?pending_tasks["']?\s*:/gi;
  let match: RegExpExecArray | null;
  let lastIdx = -1;
  while ((match = re.exec(text)) !== null) {
    lastIdx = match.index;
  }
  if (lastIdx < 0) return null;

  const slice = text.slice(lastIdx);
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  const object = slice.slice(0, end);

  let start = lastIdx;
  const before = text.slice(0, lastIdx);
  const fenceOpen = before.match(/```(?:json)?[ \t]*\n?$/i);
  if (fenceOpen) start = lastIdx - fenceOpen[0].length;

  let absEnd = lastIdx + end;
  const after = text.slice(absEnd);
  const fenceClose = after.match(/^\s*```[ \t]*(?:\n|$)/);
  if (fenceClose) absEnd += fenceClose[0].length;

  try {
    try {
      JSON.parse(object);
    } catch {
      JSON.parse(object.replace(/'/g, '"').replace(/(\w+)\s*:/g, '"$1":'));
    }
  } catch {
    return null;
  }

  return { start, end: absEnd, object };
}

function parseSummaryObject(object: string): AgentSummaryFields | null {
  try {
    let parsed: { pending_tasks?: unknown; current_work?: unknown };
    try {
      parsed = JSON.parse(object) as {
        pending_tasks?: unknown;
        current_work?: unknown;
      };
    } catch {
      const normalized = object
        .replace(/'/g, '"')
        .replace(/(\w+)\s*:/g, '"$1":');
      parsed = JSON.parse(normalized) as {
        pending_tasks?: unknown;
        current_work?: unknown;
      };
    }
    return {
      pending_tasks: Array.isArray(parsed.pending_tasks)
        ? parsed.pending_tasks.map(String)
        : [],
      current_work:
        typeof parsed.current_work === 'string' ? parsed.current_work : '',
    };
  } catch {
    return null;
  }
}

/**
 * Parse Agent summary from final answer text.
 * Returns default values if no valid JSON found.
 */
export function parseAgentSummary(finalAnswer: string): AgentSummaryFields {
  const tail = findPendingSummaryTail(finalAnswer);
  if (!tail) return DEFAULT_SUMMARY;
  return parseSummaryObject(tail.object) ?? DEFAULT_SUMMARY;
}

/**
 * Extract clean answer text by removing the appended JSON summary.
 */
export function extractCleanAnswer(finalAnswer: string): string {
  const tail = findPendingSummaryTail(finalAnswer);
  if (tail) {
    return finalAnswer.slice(0, tail.start).trim();
  }
  return finalAnswer.trim();
}

/**
 * Generate system prompt extension for Agent summary.
 * Appends to the base system prompt to instruct Agent to output JSON summary.
 */
export function getSummaryPromptExtension(): string {
  return `

When finishing a task, append a brief JSON summary at the very end of your response:
{"pending_tasks": ["明确被要求但未完成的待办"], "current_work": "最近一轮在做什么（一句话）"}`;
}
