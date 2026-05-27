import type { Dispatch, SetStateAction } from 'react';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import type { CommandInfo } from '../adapters/types';
import type { DaemonConnectionState } from './useDaemonSession';
import { mergeCommands } from './daemonSessionMappers';
import { getNumber, getRecord, getString } from './daemonSessionUtils';

export function hasAssistantDelta(
  events: readonly { type: string }[],
): boolean {
  return events.some((event) => event.type === 'assistant.text.delta');
}

export function handleSilentDaemonEvent(
  event: DaemonEvent,
  setConnection: Dispatch<SetStateAction<DaemonConnectionState>>,
): boolean {
  if (event.type === 'session_update') {
    const update = getRecord(getRecord(event.data)?.['update']);
    const tokenCount = getUsageTokenCount(update);
    if (tokenCount !== undefined) {
      setConnection((cur) => ({ ...cur, tokenCount }));
    }
    if (getString(update, 'sessionUpdate') === 'available_commands_update') {
      const { commands, skills } = mapAvailableCommandsUpdate(update);
      setConnection((cur) => ({
        ...cur,
        commands: commands.length > 0 ? commands : cur.commands,
        skills,
      }));
      return true;
    }
  }

  switch (event.type) {
    case 'model_switched': {
      const modelId = getString(getRecord(event.data), 'modelId');
      if (modelId) {
        setConnection((cur) => ({ ...cur, currentModel: modelId }));
      }
      return true;
    }
    case 'approval_mode_changed': {
      const data = getRecord(event.data);
      const mode = getString(data, 'next') ?? getString(data, 'mode');
      if (mode) {
        setConnection((cur) => ({ ...cur, currentMode: mode }));
      }
      return true;
    }
    case 'session_metadata_updated':
    case 'memory_changed':
    case 'agent_changed':
    case 'tool_toggled':
    case 'mcp_server_restarted':
    case 'mcp_server_restart_refused':
    case 'replay_complete':
      return true;
    default:
      return false;
  }
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
  commands: CommandInfo[];
  skills: string[];
} {
  if (!update) {
    return { commands: [], skills: [] };
  }
  const commandRecords = Array.isArray(update['availableCommands'])
    ? update['availableCommands']
    : [];
  const commands = commandRecords.flatMap((raw): CommandInfo[] => {
    const command = getRecord(raw);
    const name = getString(command, 'name');
    if (!name) return [];
    const input = getRecord(command?.['input']);
    return [
      {
        name,
        description: getString(command, 'description') ?? '',
        ...(getString(input, 'hint')
          ? { argumentHint: getString(input, 'hint') }
          : {}),
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
  }));
  return {
    commands: mergeCommands(commands, skillCommands),
    skills,
  };
}
