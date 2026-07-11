import type { TUI } from '@earendil-works/pi-tui';

import type { AgentRuntime } from '../../runner.js';
import {
  formatSpawnPresetDetail,
  type SpawnPresetEntry,
} from '../../spawn/preset-query.js';
import { showPaginatedTextOverlay } from './paginated-text-overlay.js';
import { buildSelectItems, showPickerOverlay } from './picker.js';

function presetDescription(entry: SpawnPresetEntry): string {
  const llm =
    entry.apiProfile || entry.model
      ? `${entry.apiProfile ?? 'inherit'}/${entry.model ?? 'default'}`
      : 'inherit parent LLM';
  const tools =
    entry.tools.length > 0 ? entry.tools.join(', ') : 'no tools';
  return `turns ${entry.maxTurns} · ${llm} · ${tools}`;
}

export async function showSpawnsBrowser(
  tui: TUI,
  runtime: AgentRuntime,
): Promise<void> {
  const { presets, orphans } = runtime.listSpawnCatalog();
  if (presets.length === 0 && orphans.length === 0) {
    await showPickerOverlay(tui, {
      title: 'Spawn presets — Esc back',
      items: buildSelectItems([
        {
          value: '__empty__',
          label: '(no spawn presets)',
          description: 'add spawn_presets to agent.json and agents/*.md',
        },
      ]),
    });
    return;
  }

  const items = buildSelectItems([
    ...presets.map((entry) => ({
      value: `preset:${entry.name}`,
      label: entry.name,
      description: presetDescription(entry),
    })),
    ...orphans.map((o) => ({
      value: `orphan:${o.relativePath}`,
      label: `(unregistered) ${o.relativePath}`,
      description: o.description ?? 'not in spawn_presets — add to agent.json to use',
    })),
  ]);

  const picked = await showPickerOverlay(tui, {
    title: 'Spawn presets — Enter detail · Esc cancel',
    items,
    maxVisible: Math.min(items.length, 12),
    onInfo: async (item, finish) => {
      if (!item.value.startsWith('preset:')) return;
      const name = item.value.slice('preset:'.length);
      const entry = presets.find((p) => p.name === name);
      if (!entry) return;
      await showPaginatedTextOverlay(tui, {
        title: `Spawn preset · ${entry.name}`,
        body: formatSpawnPresetDetail(entry),
        visibleLines: 12,
      });
      finish(null);
    },
  });

  if (!picked || picked.value === '__empty__') return;

  if (picked.value.startsWith('preset:')) {
    const name = picked.value.slice('preset:'.length);
    const entry = presets.find((p) => p.name === name);
    if (!entry) return;
    await showPaginatedTextOverlay(tui, {
      title: `Spawn preset · ${entry.name}`,
      body: formatSpawnPresetDetail(entry),
      visibleLines: 12,
    });
    return;
  }

  if (picked.value.startsWith('orphan:')) {
    const path = picked.value.slice('orphan:'.length);
    await showPaginatedTextOverlay(tui, {
      title: `Unregistered agent file`,
      body: [
        `path: ${path}`,
        '',
        'This agents/*.md file is not wired in agent.json spawn_presets.',
        'Add an entry with prompt_file to enable spawn_agent / spawn_background.',
      ].join('\n'),
      visibleLines: 10,
    });
  }
}