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

// Regex to match JSON at the end of text (supports both inline and newline-separated)
const JSON_TAIL_REGEX = /\{["']?pending_tasks["']?\s*:\s*\[[^\]]*\]\s*,\s*["']?current_work["']?\s*:\s*"[^"]*"\}$/i;

/**
 * Parse Agent summary from final answer text.
 * Returns default values if no valid JSON found.
 */
export function parseAgentSummary(finalAnswer: string): AgentSummaryFields {
  const match = finalAnswer.match(JSON_TAIL_REGEX);
  if (!match) {
    return DEFAULT_SUMMARY;
  }

  try {
    // Normalize keys to unquoted format
    const jsonStr = match[0]
      .replace(/"pending_tasks"/g, 'pending_tasks')
      .replace(/'pending_tasks'/g, 'pending_tasks')
      .replace(/"current_work"/g, 'current_work')
      .replace(/'current_work'/g, 'current_work');

    const parsed = JSON.parse(jsonStr);
    return {
      pending_tasks: Array.isArray(parsed.pending_tasks) ? parsed.pending_tasks : [],
      current_work: typeof parsed.current_work === 'string' ? parsed.current_work : '',
    };
  } catch {
    return DEFAULT_SUMMARY;
  }
}

/**
 * Extract clean answer text by removing the appended JSON summary.
 */
export function extractCleanAnswer(finalAnswer: string): string {
  const match = finalAnswer.match(/\n*\{["']?pending_tasks["']?\s*:\s*\[[^\]]*\]\s*,\s*["']?current_work["']?\s*:\s*"[^"]*"\}$/i);
  if (match) {
    return finalAnswer.slice(0, match.index).trim();
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
