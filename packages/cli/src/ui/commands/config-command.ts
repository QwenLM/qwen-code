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
  validateSettingValue,
} from '../../utils/settingsUtils.js';

const SETTABLE_TYPES = new Set(['boolean', 'string', 'number', 'enum']);

const SENSITIVE_KEY_PATTERNS = [
  /apikey/i,
  /api[_-]?key/i,
  /secret/i,
  /(?:^|\.)token(?:$|\.)/i,
  /password/i,
  /credential/i,
  /private[_-]?key/i,
];

const SENSITIVE_URL_PATTERNS = [/baseurl/i, /base_url/i, /proxy/i];

function isSensitiveKey(key: string): boolean {
  return (
    SENSITIVE_KEY_PATTERNS.some((p) => p.test(key)) ||
    SENSITIVE_URL_PATTERNS.some((p) => p.test(key))
  );
}

function maskValue(value: unknown): string {
  if (value === undefined) return t('(not set)');
  if (typeof value === 'string') {
    if (!value) return t('(empty)');
    if (value.length <= 4) return '****';
    return `${value.slice(0, 4)}****`;
  }
  return '****';
}

function findClosestKey(input: string): string | undefined {
  const allKeys = getAllSettingKeys();
  let bestMatch: string | undefined;
  let bestDistance = Infinity;

  for (const key of allKeys) {
    const def = getSettingDefinition(key);
    if (!def || !SETTABLE_TYPES.has(def.type)) continue;
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
): { value: unknown; error?: string } {
  switch (def.type) {
    case 'boolean': {
      const normalised = rawValue?.toLowerCase().trim();
      if (normalised === 'true' || normalised === '1') return { value: true };
      if (normalised === 'false' || normalised === '0') return { value: false };
      return {
        value: undefined,
        error: t('Invalid boolean value: "{{value}}". Use "true" or "false".', {
          value: String(rawValue),
        }),
      };
    }

    case 'number': {
      if (!rawValue || rawValue.trim() === '') {
        return {
          value: undefined,
          error: t('Invalid number value: "{{value}}".', {
            value: String(rawValue),
          }),
        };
      }
      const parsed = Number(rawValue);
      if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
        return {
          value: undefined,
          error: t('Invalid number value: "{{value}}".', {
            value: String(rawValue),
          }),
        };
      }
      const validationError = validateSettingValue(def, parsed);
      if (validationError) {
        return { value: undefined, error: validationError };
      }
      return { value: parsed };
    }

    case 'string': {
      const strValue = rawValue ?? '';
      const validationError = validateSettingValue(def, strValue);
      if (validationError) {
        return { value: undefined, error: validationError };
      }
      return { value: strValue };
    }

    case 'enum': {
      const validValues = def.options?.map((o) => o.value) ?? [];
      if (!validValues.includes(rawValue as never)) {
        return {
          value: undefined,
          error: t(
            'Invalid enum value: "{{value}}". Valid values: {{options}}.',
            { value: String(rawValue), options: validValues.join(', ') },
          ),
        };
      }
      return { value: rawValue };
    }

    case 'array':
    case 'object':
      return {
        value: undefined,
        error: t(
          'Setting "{{type}}" type cannot be set via /config. Edit settings.json directly.',
          { type: def.type },
        ),
      };

    default:
      return {
        value: undefined,
        error: t('Unsupported setting type: "{{type}}".', {
          type: String(def.type),
        }),
      };
  }
}

function formatValue(value: unknown): string {
  if (value === undefined) return t('(not set)');
  if (typeof value === 'string') return value || t('(empty)');
  return JSON.stringify(value);
}

function padRight(str: string, len: number): string {
  if (str.length > len) return str.slice(0, len - 3) + '... ';
  if (str.length === len) return str + ' ';
  return str + ' '.repeat(len - str.length);
}

function listAllSettings(context: CommandContext): MessageActionReturn {
  const flattened = getFlattenedSchema();
  const merged = context.services.settings.merged;

  const lines: string[] = [];

  lines.push(t('Available settings:'));
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
    if (!SETTABLE_TYPES.has(def.type)) continue;

    const current = getNestedProperty(merged as Record<string, unknown>, key);
    let displayCurrent: string;
    if (isSensitiveKey(key)) {
      displayCurrent = maskValue(current ?? def.default);
    } else {
      displayCurrent =
        current !== undefined ? formatValue(current) : formatValue(def.default);
    }

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

export const configCommand: SlashCommand = {
  name: 'config',
  get description() {
    return t('Get or set any setting by dot-path key');
  },
  argumentHint: '<key>[=<value>] or --help',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,

  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn> => {
    const trimmed = args.trim();

    if (!trimmed || trimmed === '--help' || trimmed === '-h') {
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
        content: suggestion
          ? t(
              'Unknown setting key: "{{key}}". Did you mean "{{suggestion}}"?',
              { key, suggestion },
            )
          : t('Unknown setting key: "{{key}}".', { key }),
      };
    }

    const currentValue = getNestedProperty(
      context.services.settings.merged as Record<string, unknown>,
      key,
    );

    if (isToggle && def.type !== 'boolean') {
      const display = isSensitiveKey(key)
        ? maskValue(currentValue)
        : formatValue(currentValue);
      return {
        type: 'message',
        messageType: 'info',
        content: `${key} = ${display}`,
      };
    }

    if (isToggle && def.type === 'boolean') {
      const newValue = !currentValue;
      try {
        context.services.settings.setValues([
          { scope: SettingScope.User, key, value: newValue },
        ]);
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Failed to set "{{key}}": {{error}}', {
            key,
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
      let message = t('Set {{key}} = {{value}}', {
        key,
        value: String(newValue),
      });
      if (def.requiresRestart) {
        message +=
          '\n' + t('(This setting requires a restart to take effect.)');
      }
      return {
        type: 'message',
        messageType: 'info',
        content: message,
      };
    }

    const result = coerceValue(def, rawValue);
    if (result.error) {
      return {
        type: 'message',
        messageType: 'error',
        content: result.error,
      };
    }

    if (key === 'tools.approvalMode' && result.value === 'yolo') {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Setting tools.approvalMode to "yolo" is blocked via /config for security reasons. Edit settings.json directly if you understand the risks.',
        ),
      };
    }

    try {
      context.services.settings.setValues([
        { scope: SettingScope.User, key, value: result.value },
      ]);
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Failed to set "{{key}}": {{error}}', {
          key,
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }

    const displayValue = isSensitiveKey(key)
      ? maskValue(result.value)
      : formatValue(result.value);
    let message = t('Set {{key}} = {{value}}', {
      key,
      value: displayValue,
    });
    if (def.requiresRestart) {
      message += '\n' + t('(This setting requires a restart to take effect.)');
    }
    if (isSensitiveKey(key)) {
      message +=
        '\n' +
        t(
          '(Security-sensitive setting — verify you are not exposing credentials.)',
        );
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
    return allKeys
      .filter((k) => {
        if (!k.startsWith(current)) return false;
        const def = getSettingDefinition(k);
        return def && SETTABLE_TYPES.has(def.type);
      })
      .map((k) => {
        const def = getSettingDefinition(k);
        return {
          value: k,
          description: def?.description ?? '',
        };
      });
  },
};
