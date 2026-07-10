import type { AgentRuntime, SessionModelChoice } from '../runner.js';

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
  return modelPickerItemsFromChoices(
    runtime.listSessionModelChoices(),
    runtime.getEffectiveProfileName(),
  );
}

export function modelPickerItemsFromChoices(
  choices: SessionModelChoice[],
  profileName: string,
): SelectItem[] {
  return buildSelectItems(
    choices.map((choice) => ({
      value: choice.model,
      label: `${choice.model}${choice.active ? ' (active)' : ''}`,
      description: profileName,
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
  return formatModelListClassicFromChoices(
    runtime.listSessionModelChoices(),
    runtime.getEffectiveProfileName(),
    runtime.formatSessionLlmStatus(),
  );
}

export function formatModelListClassicFromChoices(
  choices: SessionModelChoice[],
  profileName: string,
  statusLine: string,
  remoteError?: string,
): string[] {
  const lines = [`profile: ${profileName}`, statusLine];
  if (remoteError) {
    lines.push(`  ${remoteError}`);
  }
  lines.push('');
  for (const choice of choices) {
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
    pickModel: (choices: SessionModelChoice[]) => Promise<string | null>;
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
  const modelList = await runtime.listSessionModelChoicesAsync();
  if (modelList.choices.length <= 1) {
    const note = modelList.remoteError ? ` ${modelList.remoteError}` : '';
    deps.say(`${runtime.formatSessionLlmStatus()}${note}`);
    return;
  }
  const picked = await deps.pickModel(modelList.choices);
  if (!picked) return;
  deps.say(runtime.setSessionLlmModel(picked).message);
}

export async function handleLlmSlashClassic(
  runtime: AgentRuntime,
  action: LlmSlashAction,
  print: (line: string) => void,
): Promise<void> {
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
  const modelList = await runtime.listSessionModelChoicesAsync();
  if (modelList.choices.length <= 1) {
    const note = modelList.remoteError ? ` ${modelList.remoteError}` : '';
    print(`${runtime.formatSessionLlmStatus()}${note}`);
    return;
  }
  for (const line of formatModelListClassicFromChoices(
    modelList.choices,
    runtime.getEffectiveProfileName(),
    runtime.formatSessionLlmStatus(),
    modelList.remoteError,
  )) {
    print(line);
  }
}