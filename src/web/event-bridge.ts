/**
 * Map RuntimeEvent → WebSocket control frames (SPEC_WEB_UI W2).
 * Complements MessageBridge SessionMessage stream.
 */

import type { RuntimeEvent } from '../events.js';
import type { AgentRuntime } from '../runner.js';
import { listSpawnJobs } from '../spawn/job-query.js';
import type { WsHub } from './ws-hub.js';
import type {
  WebCapabilitiesFrame,
  WebJobFrame,
  WebRunStateFrame,
  WebSpawnFrame,
  WebWorkflowStepFrame,
} from './types.js';

export function attachRuntimeEventBridge(
  runtime: AgentRuntime,
  hub: WsHub,
): () => void {
  return runtime.onEvent((event: RuntimeEvent) => {
    switch (event.type) {
      case 'run_start': {
        const frame: WebRunStateFrame = {
          type: 'run_state',
          state: 'running',
          session_id: event.session_id,
          model: event.llm?.model,
        };
        hub.broadcast(frame);
        break;
      }
      case 'run_end': {
        const state: WebRunStateFrame['state'] =
          event.reason === 'aborted'
            ? 'aborted'
            : event.reason === 'error'
              ? 'error'
              : 'idle';
        const frame: WebRunStateFrame = {
          type: 'run_state',
          state,
          detail:
            event.reason === 'error'
              ? (event.message ?? 'error')
              : event.reason,
        };
        hub.broadcast(frame);
        break;
      }
      case 'run_stopping': {
        hub.broadcast({
          type: 'run_state',
          state: 'aborted',
          detail: 'stopping',
        } satisfies WebRunStateFrame);
        break;
      }
      case 'workflow_step': {
        const frame: WebWorkflowStepFrame = {
          type: 'workflow_step',
          phase: event.phase,
          role: event.role,
          round: event.round,
          nodeId: event.nodeId,
          as: event.as,
          status: 'running',
        };
        hub.broadcast(frame);
        break;
      }
      case 'workflow_handback': {
        hub.broadcast({
          type: 'workflow_handback',
          workflow: event.workflow,
          reason: event.reason,
          detail: event.detail,
          role: event.role,
          round: event.round,
        });
        break;
      }
      case 'job_list': {
        for (const j of event.jobs) {
          const frame: WebJobFrame = {
            type: 'job',
            id: j.job_id,
            status: j.status,
            label: j.preset || j.task_preview,
            stale: j.stale,
            llm_tag: j.llm_tag,
          };
          hub.broadcast(frame);
        }
        break;
      }
      case 'job_status': {
        const frame: WebJobFrame = {
          type: 'job',
          id: event.job_id,
          status: event.status,
          label: event.preset,
          stale: event.stale,
        };
        hub.broadcast(frame);
        break;
      }
      case 'system_event': {
        // Job settle notices also refresh the jobs panel (backup for job-ui-notify)
        if (event.job_id) {
          const status =
            event.kind === 'job_complete'
              ? 'completed'
              : event.kind === 'job_failed'
                ? 'failed'
                : event.kind === 'job_cancelled'
                  ? 'cancelled'
                  : String(event.kind).replace(/^job_/, '') || 'settled';
          const frame: WebJobFrame = {
            type: 'job',
            id: event.job_id,
            status,
            label: event.summary?.slice(0, 48),
          };
          hub.broadcast(frame);
        }
        break;
      }
      case 'spawn_start': {
        const frame: WebSpawnFrame = {
          type: 'spawn',
          phase: 'start',
          preset: event.preset,
        };
        hub.broadcast(frame);
        break;
      }
      case 'spawn_end': {
        const frame: WebSpawnFrame = {
          type: 'spawn',
          phase: 'end',
          preset: event.preset,
          ok: event.ok,
          detail: event.detail,
        };
        hub.broadcast(frame);
        break;
      }
      case 'runtime': {
        const frame: WebCapabilitiesFrame = {
          type: 'capabilities',
          shell: event.shell,
          web: event.web,
        };
        hub.broadcast(frame);
        break;
      }
      default:
        break;
    }
  });
}

/** Snapshot jobs for HTTP / hello (no RuntimeEvent fan-out). */
export function snapshotJobs(_runtime?: AgentRuntime): WebJobFrame[] {
  const jobs = listSpawnJobs({ limit: 30 });
  return jobs.map((j) => ({
    type: 'job' as const,
    id: j.job_id,
    status: j.status,
    label: j.preset || j.task_preview?.slice(0, 48),
  }));
}
