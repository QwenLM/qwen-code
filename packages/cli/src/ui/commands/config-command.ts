/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandContext,
  MessageActionReturn,
  SlashCommand,
} from './types.js';
import { CommandKind } from './types.js';
import { SettingScope } from '../../config/settings.js';
import type { SettingDefinition } from '../../config/settingsSchema.js';
import { t } from '../../i18n/index.js';
import {
  getAllSettingKeys,
  getFlattenedSchema,
  getNestedProperty,
  getSettingDefinition,
} from '../../utils/settingsUtils.js';

function findClosestKey(input: string): string | undefined {
  const allKeys = getAllSettingKeys();
  let bestMatch: string | undefined;
  let bestDistance = Infinity;

  for (const key of allKeys) {
    const distance = levenshteinDistance(
      input.toLowerCase(),
      key.toLowerCase(),
    );
    if (distance < bestDistance && distance <= 3) {
      bestDistance = distance;
      bestMatch = key;
    }
  }

  return bestMatch;
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      );
    }
  }

  return matrix[a.length]![b.length]!;
}

function coerceValue(
  def: SettingDefinition,
  rawValue: string | undefined,
  isToggle: boolean,
  currentValue: unknown,
): { value: unknown; error?: string } {
  switch (def.type) {
    case 'boolean': {
      if (isToggle) {
        return { value: !currentValue };
      }
      if (rawValue === 'true') return { value: true };
      if (rawValue === 'false') return { value: false };
      return {
        value: undefined,
        error: `Invalid boolean value: "${rawValue}". Use "true" or "false".`,
      };
    }

    case 'number': {
      if (isToggle) {
        return {
          value: undefined,
          error: `Cannot toggle a number setting. Provide a value: key=<number>.`,
        };
      }
      const parsed = Number(rawValue);
      if (Number.isNaN(parsed)) {
        return {
          value: undefined,
          error: `Invalid number value: "${rawValue}".`,
        };
      }
      return { value: parsed };
    }

    case 'string': {
      if (isToggle) {
        return {
          value: undefined,
          error: `Cannot toggle a string setting. Provide a value: key=<value>.`,
        };
      }
      return { value: rawValue ?? '' };
    }

    case 'enum': {
      if (isToggle) {
        return {
          value: undefined,
          error: `Cannot toggle an enum setting. Provide one of: ${def.options?.map((o) => o.value).join(', ')}.`,
        };
      }
      const validValues = def.options?.map((o) => o.value) ?? [];
      if (!validValues.includes(rawValue as never)) {
        return {
          value: undefined,
          error: `Invalid enum value: "${rawValue}". Valid values: ${validValues.join(', ')}.`,
        };
      }
      return { value: rawValue };
    }

    case 'array':
    case 'object':
      return {
        value: undefined,
        error: `Setting "${def.type}" type cannot be set via /config. Edit settings.json directly.`,
      };

    default:
      return {
        value: undefined,
        error: `Unsupported setting type: "${def.type}".`,
      };
  }
}

function formatValue(value: unknown): string {
  if (value === undefined) return '(not set)';
  if (typeof value === 'string') return value || '(empty)';
  return JSON.stringify(value);
}

function listAllSettings(context: CommandContext): MessageActionReturn {
  const flattened = getFlattenedSchema();
  const merged = context.services.settings.merged;

  const settableTypes = new Set(['boolean', 'string', 'number', 'enum']);
  const lines: string[] = [];

  lines.push('Available settings:');
  lines.push('');
  lines.push(
    padRight('Key', 40) +
      padRight('Type', 10) +
      padRight('Current', 15) +
      'Description',
  );
  lines.push('-'.repeat(90));

  const keys = Object.keys(flattened).sort();
  for (const key of keys) {
    const def = flattened[key]!;
    if (!settableTypes.has(def.type)) continue;

    const current = getNestedProperty(merged as Record<string, unknown>, key);
    const displayCurrent =
      current !== undefined ? formatValue(current) : formatValue(def.default);

    lines.push(
      padRight(key, 40) +
        padRight(def.type, 10) +
        padRight(displayCurrent, 15) +
        (def.description ?? def.label),
    );
  }

  return {
    type: 'message',
    messageType: 'info',
    content: lines.join('\n'),
  };
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str + ' ' : str + ' '.repeat(len - str.length);
}

export const configCommand: SlashCommand = {
  name: 'config',
  get description() {
    return t('Get or set any setting by dot-path key');
  },
  argumentHint: '<key>[=<value>] or --help',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'],

  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn> => {
    const trimmed = args.trim();

    if (!trimmed) {
      return listAllSettings(context);
    }

    if (trimmed === '--help' || trimmed === '-h') {
      return listAllSettings(context);
    }

    const eqIndex = trimmed.indexOf('=');
    const isToggle = eqIndex === -1;
    const key = isToggle ? trimmed : trimmed.slice(0, eqIndex).trim();
    const rawValue = isToggle ? undefined : trimmed.slice(eqIndex + 1).trim();

    const def = getSettingDefinition(key);
    if (!def) {
      const suggestion = findClosestKey(key);
      return {
        type: 'message',
        messageType: 'error',
        content: `Unknown setting key: "${key}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
      };
    }

    const currentValue = getNestedProperty(
      context.services.settings.merged as Record<string, unknown>,
      key,
    );

    const result = coerceValue(def, rawValue, isToggle, currentValue);
    if (result.error) {
      return {
        type: 'message',
        messageType: 'error',
        content: result.error,
      };
    }

    context.services.settings.setValue(SettingScope.User, key, result.value);

    let message = `Set ${key} = ${JSON.stringify(result.value)}`;
    if (def.requiresRestart) {
      message += '\n(This setting requires a restart to take effect.)';
    }

    return {
      type: 'message',
      messageType: 'info',
      content: message,
    };
  },

  completion: async (_context, partialArg) => {
    const current = partialArg.trimStart();
    if (current.includes('=')) return null;

    const allKeys = getAllSettingKeys();
    const settableTypes = new Set(['boolean', 'string', 'number', 'enum']);
    return allKeys
      .filter((k) => {
        const def = getSettingDefinition(k);
        return def && settableTypes.has(def.type) && k.startsWith(current);
      })
      .map((k) => ({
        value: k,
        description: getSettingDefinition(k)?.description ?? '',
      }));
  },
};
