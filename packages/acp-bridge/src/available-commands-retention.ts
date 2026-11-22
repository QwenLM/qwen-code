/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function commandUpdate(event: { type: string; data: unknown }):
  | {
      data: Record<string, unknown>;
      update: Record<string, unknown>;
      wrapped: boolean;
    }
  | undefined {
  if (event.type !== 'session_update') return undefined;
  const data = asRecord(event.data);
  if (!data) return undefined;
  const wrapped = asRecord(data['update']);
  const update = wrapped ?? data;
  if (update['sessionUpdate'] !== 'available_commands_update') return undefined;
  return { data, update, wrapped: wrapped !== undefined };
}

export function isAvailableCommandsEvent(event: {
  type: string;
  data: unknown;
}): boolean {
  return commandUpdate(event) !== undefined;
}

export function omitAvailableSkillDetails<
  T extends { type: string; data: unknown },
>(event: T): T {
  const command = commandUpdate(event);
  if (!command) return event;
  const meta = asRecord(command.update['_meta']);
  if (!meta || !('availableSkillDetails' in meta)) return event;
  const trimmedMeta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key !== 'availableSkillDetails') trimmedMeta[key] = value;
  }
  const update = { ...command.update };
  if (Object.keys(trimmedMeta).length > 0) {
    update['_meta'] = trimmedMeta;
  } else {
    delete update['_meta'];
  }
  return {
    ...event,
    data: command.wrapped ? { ...command.data, update } : update,
  };
}
