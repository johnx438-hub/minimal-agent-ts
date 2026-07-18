/**
 * Shared slash command layer (parse + runtime dispatch).
 * TUI keeps overlay handlers in `src/tui/slash-handlers.ts`.
 */

export type {
  ApproveAction,
  ApproveKind,
  ImageSlashAction,
  JobsSlashAction,
  LlmSlashAction,
  SlashHelpEntry,
  SlashLocale,
  SlashResult,
  SpawnsSlashAction,
} from './parse.js';

export {
  formatSlashHelpLines,
  isSlashCommand,
  normalizeReplInput,
  normalizeSlashLine,
  parseSlashLine,
  SLASH_HELP_LINES,
  slashAutocompleteItems,
} from './parse.js';

export {
  broadcastArmed,
  broadcastLlm,
  dispatchWebCommand,
  llmStatus,
  type CommandResult,
} from './dispatch-runtime.js';
