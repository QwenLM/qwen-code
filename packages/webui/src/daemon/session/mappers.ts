/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dispatch, SetStateAction } from 'react';
import type {
  DaemonAvailableCommand,
  DaemonEvent,
  DaemonSessionContextStatus,
  DaemonSessionSupportedCommandsStatus,
  DaemonWorkspaceProvidersStatus,
} from '@qwen-code/sdk/daemon';
import type {
  DaemonCommandInfo,
  DaemonConnectionState,
  DaemonModelInfo,
} from './types.js';

export function mapProviderStatus(
  status: DaemonWorkspaceProvidersStatus | undefined,
): {
  models: DaemonModelInfo[];
  currentModel?: string;
  contextWindow?: number;
} {
  if (!status) return { models: [] };
  const seen = new Set<string>();
  const models: DaemonModelInfo[] = [];
  let currentModel = status.current?.modelId;
  let contextWindow: number | undefined;

  for (const provider of status.providers) {
    for (const model of provider.models) {
      if (!currentModel && model.isCurrent) currentModel = model.modelId;
      if (
        contextWindow === undefined &&
        (model.isCurrent || model.modelId === currentModel)
      ) {
        contextWindow = model.contextLimit;
      }
      if (seen.has(model.modelId)) continue;
      seen.add(model.modelId);
      models.push({
        id: model.modelId,
        label: model.name || model.modelId,
        ...(model.contextLimit !== undefined
          ? { contextWindow: model.contextLimit }
          : {}),
      });
    }
  }

  return { models, currentModel, contextWindow };
}

export function mapSupportedCommands(
  status: DaemonSessionSupportedCommandsStatus | undefined,
): {
  commands: DaemonCommandInfo[];
  skills: string[];
} {
  if (!status) return { commands: [], skills: [] };

  const commands = status.availableCommands.map((command) => ({
    name: command.name,
    description: command.description || '',
    ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
    raw: command,
  }));
  const skillCommands = status.availableSkills.map((skill) => ({
    name: skill,
    description: '',
    raw: {
      name: skill,
      description: '',
      input: null,
      _meta: { source: 'skill' },
    } satisfies DaemonAvailableCommand,
  }));

  return {
    commands: mergeCommands(commands, skillCommands),
    skills: status.availableSkills,
  };
}

export function mergeCommands(
  ...groups: DaemonCommandInfo[][]
): DaemonCommandInfo[] {
  const byName = new Map<string, DaemonCommandInfo>();
  for (const group of groups) {
    for (const command of group) {
      const existing = byName.get(command.name);
      if (existing) {
        byName.set(command.name, {
          ...existing,
          ...command,
          description: command.description || existing.description,
          argumentHint: command.argumentHint ?? existing.argumentHint,
          raw: command.raw,
        });
      } else {
        byName.set(command.name, command);
      }
    }
  }
  return [...byName.values()];
}

export function updateConnectionFromDaemonEvent(
  event: DaemonEvent,
  setConnection: Dispatch<SetStateAction<DaemonConnectionState>>,
): void {
  if (event.type === 'session_update') {
    const update = getRecord(getRecord(event.data)?.['update']);
    const tokenCount = getUsageTokenCount(update);
    if (tokenCount !== undefined) {
      setConnection((current) => ({ ...current, tokenCount }));
    }
    if (getString(update, 'sessionUpdate') === 'available_commands_update') {
      const { commands, skills } = mapAvailableCommandsUpdate(update);
      setConnection((current) => ({
        ...current,
        commands: commands.length > 0 ? commands : current.commands,
        skills,
      }));
    }
    return;
  }

  switch (event.type) {
    case 'model_switched': {
      const modelId = getString(getRecord(event.data), 'modelId');
      if (modelId) {
        setConnection((current) => ({ ...current, currentModel: modelId }));
      }
      break;
    }
    case 'approval_mode_changed': {
      const data = getRecord(event.data);
      const mode = getString(data, 'next') ?? getString(data, 'mode');
      if (mode) {
        setConnection((current) => ({ ...current, currentMode: mode }));
      }
      break;
    }
    default:
      break;
  }
}

export function getCurrentMode(
  status: DaemonSessionContextStatus | undefined,
): string | undefined {
  const modes = getRecord(status?.state?.modes);
  return getString(modes, 'currentModeId') ?? getString(modes, 'currentMode');
}

function getUsageTokenCount(
  update: Record<string, unknown> | undefined,
): number | undefined {
  const usage = getRecord(getRecord(update?.['_meta'])?.['usage']);
  const count =
    getNumber(usage, 'inputTokens') ?? getNumber(usage, 'totalTokens');
  return count !== undefined && count > 0 ? count : undefined;
}

function mapAvailableCommandsUpdate(
  update: Record<string, unknown> | undefined,
): {
  commands: DaemonCommandInfo[];
  skills: string[];
} {
  if (!update) return { commands: [], skills: [] };

  const commandRecords = Array.isArray(update['availableCommands'])
    ? update['availableCommands']
    : [];
  const commands = commandRecords.flatMap((raw): DaemonCommandInfo[] => {
    const command = getRecord(raw);
    const name = getString(command, 'name');
    if (!name) return [];
    const input = getRecord(command?.['input']);
    const daemonCommand: DaemonAvailableCommand = {
      name,
      description: getString(command, 'description') ?? '',
      input: input ? { hint: getString(input, 'hint') ?? '' } : null,
      _meta: getRecord(command?.['_meta']) ?? null,
    };
    return [
      {
        name,
        description: daemonCommand.description ?? '',
        ...(daemonCommand.input?.hint
          ? { argumentHint: daemonCommand.input.hint }
          : {}),
        raw: daemonCommand,
      },
    ];
  });
  const skills = Array.isArray(update['availableSkills'])
    ? update['availableSkills'].filter(
        (skill): skill is string => typeof skill === 'string',
      )
    : [];
  const skillCommands = skills.map((skill) => ({
    name: skill,
    description: '',
    raw: {
      name: skill,
      description: '',
      input: null,
      _meta: { source: 'skill' },
    } satisfies DaemonAvailableCommand,
  }));

  return {
    commands: mergeCommands(commands, skillCommands),
    skills,
  };
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
