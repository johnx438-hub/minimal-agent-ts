import type { AgentRuntime } from '../runner.js';

import type { LlmSlashAction } from './slash.js';
import { buildSelectItems } from './pi/picker.js';
import type { SelectItem } from '@earendil-works/pi-tui';

export function profilePickerItems(runtime: AgentRuntime): SelectItem[] {
  return buildSelectItems(
    runtime.listSessionProfileChoices().map((choice) => {
      const tags = [
        choice.active ? '(active)' : '',
        choice.available ? '' : '(no key)',
      ]
        .filter(Boolean)
        .join(' ');
      const suffix = tags ? ` ${tags}` : '';
      return {
        value: choice.name,
        label: `${choice.name}${suffix}`,
        description:
          choice.unavailableReason ??
          choice.displayName ??
          choice.name,
      };
    }),
  );
}

export function modelPickerItems(runtime: AgentRuntime): SelectItem[] {
  return buildSelectItems(
    runtime.listSessionModelChoices().map((choice) => ({
      value: choice.model,
      label: `${choice.model}${choice.active ? ' (active)' : ''}`,
      description: runtime.getEffectiveProfileName(),
    })),
  );
}

export function formatProfileListClassic(runtime: AgentRuntime): string[] {
  const lines = [runtime.formatSessionLlmStatus(), ''];
  for (const choice of runtime.listSessionProfileChoices()) {
    const tags = [
      choice.active ? '(active)' : '',
      choice.available ? '' : '(no key)',
    ]
      .filter(Boolean)
      .join(' ');
    const label = choice.displayName ? ` — ${choice.displayName}` : '';
    lines.push(`  ${choice.name}${tags ? ` ${tags}` : ''}${label}`);
    if (!choice.available && choice.unavailableReason) {
      lines.push(`    ${choice.unavailableReason}`);
    }
  }
  lines.push('  (pi TUI: /profile opens picker; or /profile <name>)');
  return lines;
}

export function formatModelListClassic(runtime: AgentRuntime): string[] {
  const lines = [
    `profile: ${runtime.getEffectiveProfileName()}`,
    runtime.formatSessionLlmStatus(),
    '',
  ];
  for (const choice of runtime.listSessionModelChoices()) {
    lines.push(`  ${choice.model}${choice.active ? ' (active)' : ''}`);
  }
  lines.push('  (pi TUI: /model opens picker; or /model <id>)');
  return lines;
}

export async function handleLlmSlashPi(
  runtime: AgentRuntime,
  action: LlmSlashAction,
  deps: {
    say: (message: string, meta?: boolean) => void;
    pickProfile: () => Promise<string | null>;
    pickModel: () => Promise<string | null>;
  },
): Promise<void> {
  if (action.kind === 'profile') {
    if (action.mode === 'reset') {
      runtime.resetSessionLlmOverride();
      deps.say('LLM session override cleared (profile + model)');
      return;
    }
    if (action.mode === 'set') {
      deps.say(runtime.setSessionLlmProfile(action.name!).message);
      return;
    }
    const choices = runtime.listSessionProfileChoices();
    if (choices.length <= 1) {
      deps.say(runtime.formatSessionLlmStatus());
      return;
    }
    const picked = await deps.pickProfile();
    if (!picked) return;
    const choice = choices.find((c) => c.name === picked);
    if (choice && !choice.available) {
      deps.say(`✗ ${choice.unavailableReason ?? 'profile unavailable'}`);
      return;
    }
    deps.say(runtime.setSessionLlmProfile(picked).message);
    return;
  }

  if (action.mode === 'reset') {
    runtime.resetSessionLlmModel();
    deps.say('model override cleared');
    return;
  }
  if (action.mode === 'set') {
    deps.say(runtime.setSessionLlmModel(action.model!).message);
    return;
  }
  const models = runtime.listSessionModelChoices();
  if (models.length <= 1) {
    deps.say(runtime.formatSessionLlmStatus());
    return;
  }
  const picked = await deps.pickModel();
  if (!picked) return;
  deps.say(runtime.setSessionLlmModel(picked).message);
}

export function handleLlmSlashClassic(
  runtime: AgentRuntime,
  action: LlmSlashAction,
  print: (line: string) => void,
): void {
  if (action.kind === 'profile') {
    if (action.mode === 'reset') {
      runtime.resetSessionLlmOverride();
      print('LLM session override cleared (profile + model)');
      return;
    }
    if (action.mode === 'set') {
      print(runtime.setSessionLlmProfile(action.name!).message);
      return;
    }
    const choices = runtime.listSessionProfileChoices();
    if (choices.length <= 1) {
      print(runtime.formatSessionLlmStatus());
      return;
    }
    for (const line of formatProfileListClassic(runtime)) {
      print(line);
    }
    return;
  }

  if (action.mode === 'reset') {
    runtime.resetSessionLlmModel();
    print('model override cleared');
    return;
  }
  if (action.mode === 'set') {
    print(runtime.setSessionLlmModel(action.model!).message);
    return;
  }
  const models = runtime.listSessionModelChoices();
  if (models.length <= 1) {
    print(runtime.formatSessionLlmStatus());
    return;
  }
  for (const line of formatModelListClassic(runtime)) {
    print(line);
  }
}