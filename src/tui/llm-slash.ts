import type { AgentRuntime, SessionModelChoice, SessionReasoningChoice } from '../runner.js';

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

export function reasoningPickerItems(runtime: AgentRuntime): SelectItem[] {
  return reasoningPickerItemsFromChoices(
    runtime.listSessionReasoningChoices(),
    runtime.getEffectiveProfileName(),
  );
}

export function reasoningPickerItemsFromChoices(
  choices: SessionReasoningChoice[],
  profileName: string,
): SelectItem[] {
  return buildSelectItems(
    choices.map((choice) => ({
      value: choice.level,
      label: `${choice.level}${choice.active ? ' (active)' : ''}`,
      description: profileName,
    })),
  );
}

export async function handleLlmSlashPi(
  runtime: AgentRuntime,
  action: LlmSlashAction,
  deps: {
    say: (message: string, meta?: boolean) => void;
    pickProfile: () => Promise<string | null>;
    pickModel: (choices: SessionModelChoice[]) => Promise<string | null>;
    pickReasoning: () => Promise<string | null>;
  },
): Promise<void> {
  if (action.kind === 'profile') {
    if (action.mode === 'reset') {
      runtime.resetSessionLlmOverride();
      deps.say('LLM session override cleared (profile + model + reasoning)');
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

  if (action.kind === 'model') {
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
    return;
  }

  if (action.kind === 'reasoning') {
    if (action.mode === 'reset') {
      runtime.resetSessionReasoningLevel();
      deps.say('reasoning override cleared');
      return;
    }
    if (action.mode === 'set') {
      deps.say(runtime.setSessionReasoningLevel(action.level!).message);
      return;
    }
    const choices = runtime.listSessionReasoningChoices();
    if (choices.length <= 1) {
      deps.say(runtime.formatSessionLlmStatus());
      return;
    }
    const picked = await deps.pickReasoning();
    if (!picked) return;
    deps.say(runtime.setSessionReasoningLevel(picked).message);
  }
}