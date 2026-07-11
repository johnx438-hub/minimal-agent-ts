import type { TUI } from '@earendil-works/pi-tui';

import type { AgentRuntime } from '../../runner.js';
import { formatJobLlmTag, isStaleJob } from '../../spawn/job-query.js';
import type { SpawnJobMeta } from '../../spawn/job-store.js';
import { showPaginatedTextOverlay } from './paginated-text-overlay.js';
import { buildSelectItems, showPickerOverlay } from './picker.js';

function jobPickerDescription(meta: SpawnJobMeta): string {
  const llm = formatJobLlmTag(meta);
  const preview =
    meta.task_preview.length > 56
      ? `${meta.task_preview.slice(0, 55)}…`
      : meta.task_preview;
  const stale = isStaleJob(meta) ? ' · stale' : '';
  return `${meta.status} · ${llm} · ${preview}${stale}`;
}

export async function showJobsBrowser(
  tui: TUI,
  runtime: AgentRuntime,
): Promise<void> {
  const jobs = runtime.listBackgroundJobs({ limit: 20 });
  if (jobs.length === 0) {
    await showPickerOverlay(tui, {
      title: 'Background jobs — Esc back',
      items: buildSelectItems([
        {
          value: '__empty__',
          label: '(no background jobs)',
          description: 'spawn_background or code_review background=true',
        },
      ]),
    });
    return;
  }

  const items = buildSelectItems(
    jobs.map((meta) => ({
      value: meta.job_id,
      label: `${meta.job_id}  ${meta.preset}`,
      description: jobPickerDescription(meta),
    })),
  );

  const picked = await showPickerOverlay(tui, {
    title: 'Jobs — Enter status · t tail · Esc cancel',
    items,
    maxVisible: Math.min(items.length, 12),
    onKey: async (key, ctx) => {
      if (key !== 't' && key !== 'T') return false;
      const item = ctx.getSelectedItem();
      if (!item || item.value === '__empty__') return true;
      const body = runtime.getBackgroundJobEventsText(item.value);
      if (!body) {
        ctx.finish(null);
        return true;
      }
      await showPaginatedTextOverlay(tui, {
        title: `Job events · ${item.value}`,
        body,
        visibleLines: 14,
      });
      return true;
    },
  });

  if (!picked || picked.value === '__empty__') return;

  const status = runtime.getBackgroundJobStatus(picked.value, 8);
  if (!status) return;

  await showPaginatedTextOverlay(tui, {
    title: `Job status · ${picked.value}`,
    body: status,
    visibleLines: 14,
  });
}

export async function showJobStatusOverlay(
  tui: TUI,
  runtime: AgentRuntime,
  jobId: string,
): Promise<void> {
  const status = runtime.getBackgroundJobStatus(jobId, 8);
  if (!status) {
    await showPickerOverlay(tui, {
      title: `Job not found: ${jobId}\nEsc back`,
      items: buildSelectItems([
        { value: 'missing', label: '(unknown job_id)', description: jobId },
      ]),
    });
    return;
  }

  await showPaginatedTextOverlay(tui, {
    title: `Job status · ${jobId}`,
    body: status,
    visibleLines: 14,
  });
}

export async function showJobTailOverlay(
  tui: TUI,
  runtime: AgentRuntime,
  jobId: string,
): Promise<void> {
  const body = runtime.getBackgroundJobEventsText(jobId);
  if (!body) {
    await showPickerOverlay(tui, {
      title: `Job not found: ${jobId}\nEsc back`,
      items: buildSelectItems([
        { value: 'missing', label: '(unknown job_id)', description: jobId },
      ]),
    });
    return;
  }

  await showPaginatedTextOverlay(tui, {
    title: `Job events · ${jobId}`,
    body,
    visibleLines: 14,
  });
}