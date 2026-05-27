import type {
  DaemonSessionContextStatus,
  DaemonSessionSupportedCommandsStatus,
  DaemonWorkspaceProvidersStatus,
} from '@qwen-code/sdk/daemon';
import type { CommandInfo, ModelInfo } from '../adapters/types';
import { getRecord, getString } from './daemonSessionUtils';

export function mapProviderStatus(
  status: DaemonWorkspaceProvidersStatus | undefined,
): {
  models: ModelInfo[];
  currentModel?: string;
  contextWindow?: number;
} {
  if (!status) {
    return { models: [] };
  }

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  let currentModel = status.current?.modelId;
  let contextWindow: number | undefined;

  for (const provider of status.providers) {
    for (const model of provider.models) {
      if (!currentModel && model.isCurrent) {
        currentModel = model.modelId;
      }
      if (
        !contextWindow &&
        (model.isCurrent || model.modelId === currentModel)
      ) {
        contextWindow = model.contextLimit;
      }
      if (seen.has(model.modelId)) {
        continue;
      }
      seen.add(model.modelId);
      models.push({
        id: model.modelId,
        label: model.name || model.modelId,
      });
    }
  }

  return { models, currentModel, contextWindow };
}

export function mapSupportedCommands(
  status: DaemonSessionSupportedCommandsStatus | undefined,
): {
  commands: CommandInfo[];
  skills: string[];
} {
  if (!status) {
    return { commands: [], skills: [] };
  }

  const commands = status.availableCommands.map((command) => ({
    name: command.name,
    description: command.description || '',
    ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
  }));

  const skillCommands = status.availableSkills.map((skill) => ({
    name: skill,
    description: '',
  }));

  return {
    commands: mergeCommands(commands, skillCommands),
    skills: status.availableSkills,
  };
}

export function mergeCommands(...groups: CommandInfo[][]): CommandInfo[] {
  const byName = new Map<string, CommandInfo>();
  for (const group of groups) {
    for (const command of group) {
      const existing = byName.get(command.name);
      if (existing) {
        byName.set(command.name, {
          ...existing,
          ...command,
          description: command.description || existing.description,
          argumentHint: command.argumentHint ?? existing.argumentHint,
        });
      } else {
        byName.set(command.name, command);
      }
    }
  }
  return [...byName.values()];
}

export function getCurrentMode(
  status: DaemonSessionContextStatus | undefined,
): string | undefined {
  const modes = getRecord(status?.state?.modes);
  return getString(modes, 'currentModeId') ?? getString(modes, 'currentMode');
}
