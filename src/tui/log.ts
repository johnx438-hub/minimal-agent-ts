import {
  formatActionFlushSummary,
  formatIndexFlushSummary,
  isActionIoMetricsEnabled,
} from '../action-io-metrics.js';
import {
  formatRunStartLlmSummary,
  type AgentStepEvent,
  type RuntimeEvent,
} from '../events.js';
import { printStepEvent } from '../runner.js';
import { renderMarkdownForTerminal, shouldFormatFinal } from './markdown.js';

function isAgentStep(event: RuntimeEvent): event is AgentStepEvent {
  return (
    event.type === 'turn_start' ||
    event.type === 'token' ||
    event.type === 'llm_done' ||
    event.type === 'llm_retry' ||
    event.type === 'llm_fallback' ||
    event.type === 'tool_plan' ||
    event.type === 'tool_batch' ||
    event.type === 'tool_call' ||
    event.type === 'tool_result' ||
    event.type === 'compression' ||
    event.type === 'draft_discarded' ||
    event.type === 'loop_guard' ||
    event.type === 'turn_io' ||
    event.type === 'final'
  );
}

function printAgentStep(event: AgentStepEvent): void {
  if (event.type === 'final') {
    console.log(`\n[done @ turn ${event.turn}]`);
    if (shouldFormatFinal(event.text)) {
      console.log('─'.repeat(40) + ' formatted ' + '─'.repeat(40));
      console.log(renderMarkdownForTerminal(event.text));
      console.log('─'.repeat(88));
    }
    return;
  }
  printStepEvent(event);
}

/** Append-only scroll log (same discipline as headless CLI). */
export function printRuntimeEvent(event: RuntimeEvent): void {
  if (isAgentStep(event)) {
    printAgentStep(event);
    return;
  }

  switch (event.type) {
    case 'run_start':
      console.log('─'.repeat(60));
      console.log(`▶ task start  session=${event.session_id}`);
      console.log(`  cwd: ${event.cwd}`);
      if (event.llm) {
        console.log(`  llm: ${formatRunStartLlmSummary(event.llm)}`);
      }
      break;

    case 'run_stopping':
      console.log('… stopping (waiting for current step)');
      break;

    case 'run_end':
      if (event.reason === 'aborted') {
        console.log('\n⊗ run aborted (session saved)');
      } else if (event.reason === 'error') {
        console.log(`\n✗ run error: ${event.message ?? 'unknown'}`);
      } else {
        console.log('\n✓ run completed');
      }
      console.log('─'.repeat(60));
      break;

    case 'session_saved':
      console.log(`💾 session saved (${event.task_count} tasks)`);
      break;

    case 'runtime':
      console.log(`⚙ shell:${event.shell ? 'on' : 'off'} web:${event.web ? 'on' : 'off'}`);
      break;

    case 'permission_prompt_start':
      console.log(`permission ▶ ${event.kind} (${event.reason})`);
      break;

    case 'permission_prompt_end':
      console.log(
        `permission ${event.approved ? '✓' : '⊗'} ${event.kind} (${event.reason})`,
      );
      break;

    case 'workflow_confirm_start':
      console.log(`workflow confirm ▶ ${event.workflow} (awaiting approval)`);
      console.log(`  path: ${event.path}`);
      console.log(
        `  shell: ${event.needs_shell ? 'required' : 'not required'}  web: ${event.needs_web ? 'required' : 'not required'}`,
      );
      break;

    case 'workflow_confirm_end':
      console.log(
        `workflow confirm ${event.approved ? '✓' : '⊗'} ${event.workflow} (${event.reason})`,
      );
      break;

    case 'workflow_step': {
      const round = event.round !== undefined ? ` round ${event.round}` : '';
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`workflow ▶ ${event.phase} / ${event.role}${round}`);
      console.log('═'.repeat(60));
      break;
    }

    case 'workflow_handback': {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`workflow handback ▶ ${event.workflow} (${event.reason})`);
      if (event.role) {
        console.log(
          `  role: ${event.role}${event.round !== undefined ? ` round ${event.round}` : ''}`,
        );
      }
      console.log(`  ${event.detail}`);
      console.log('═'.repeat(60));
      break;
    }

    case 'spawn_start':
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`spawn ▶ ${event.preset}`);
      console.log('═'.repeat(60));
      break;

    case 'spawn_end':
      console.log(event.ok ? `\nspawn ✓ ${event.preset}` : `\nspawn ✗ ${event.preset}: ${event.detail ?? 'failed'}`);
      break;

    case 'action_flush':
      if (isActionIoMetricsEnabled()) {
        console.log(`  💾 ${formatActionFlushSummary(event)}`);
      }
      return;

    case 'index_flush':
      if (isActionIoMetricsEnabled()) {
        console.log(`  🔍 ${formatIndexFlushSummary(event)}`);
      }
      return;
  }
}