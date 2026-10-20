/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import {
  MOD_MAX_BYTES,
  type ModOptions,
  type ModToolDialect,
} from './types.js';

const option = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
]);
const field = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
    title: z.string(),
    description: z.string(),
    required: z.boolean().optional(),
    default: option.optional(),
    multiple: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    options: z.array(z.string().min(1).max(64)).nonempty().optional(),
  })
  .strict()
  .refine((value) => {
    if (!value.options) return true;
    return (
      value.type === 'string' &&
      !value.multiple &&
      !value.sensitive &&
      value.options.every(
        (item) => item.trim() === item && !/[\p{Cc}\p{Cf}]/u.test(item),
      ) &&
      new Set(value.options.map((item) => item.toLowerCase())).size ===
        value.options.length &&
      (value.default === undefined
        ? value.required === true
        : value.options.includes(value.default as string))
    );
  });
const schema = z.record(z.string().regex(/^[A-Za-z_]\w*$/), field);
const storedOptions = z.record(option);

function* pluginConfigurations(
  scopes: readonly unknown[],
  name: string,
  marketplace?: string,
): Generator<Record<string, unknown>> {
  const keys = marketplace
    ? [`${name}@${marketplace}`]
    : [name, `${name}@inline`];
  for (const scope of scopes) {
    if (scope === undefined) continue;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
      throw new Error('Invalid Mod pluginConfigs settings.');
    }
    for (const key of keys) {
      if (!Object.hasOwn(scope, key)) continue;
      const config = (scope as Record<string, unknown>)[key];
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('Invalid Mod pluginConfigs entry.');
      }
      yield config as Record<string, unknown>;
    }
  }
}

export function resolveModToolDialect(
  scopes: readonly unknown[],
  name: string,
  marketplace?: string,
): ModToolDialect {
  let dialect: ModToolDialect = 'native';
  for (const config of pluginConfigurations(scopes, name, marketplace)) {
    const value = config['toolDialect'];
    if (value === undefined) continue;
    if (value !== 'native' && value !== 'claude')
      throw new Error('Invalid Mod toolDialect: expected native or claude.');
    dialect = value;
  }
  return dialect;
}

export function resolveModOptions(
  declaration: unknown,
  scopes: readonly unknown[],
  name: string,
  marketplace?: string,
): ModOptions {
  const parsed = schema.safeParse(declaration === undefined ? {} : declaration);
  if (!parsed.success) throw new Error('Invalid Mod userConfig declaration.');
  const fields = Object.entries(parsed.data);
  if (!fields.length) return {};
  if (fields.some(([, value]) => value.sensitive)) {
    throw new Error('Sensitive Mod userConfig is not supported yet.');
  }
  let stored: ModOptions = {};
  for (const config of pluginConfigurations(scopes, name, marketplace)) {
    const options = config['options'];
    if (options === undefined) continue;
    const values = storedOptions.safeParse(options);
    if (!values.success)
      throw new Error(
        `Invalid Mod configured option: ${String(values.error.issues[0]?.path[0] ?? '').slice(0, 64)}.`,
      );
    stored = { ...stored, ...values.data };
  }
  const result: ModOptions = Object.fromEntries(
    fields
      .filter(([, config]) => config.default !== undefined || !config.required)
      .map(([key, config]) => [key, config.default ?? '']),
  );
  for (const [key, value] of Object.entries(stored)) {
    const choices = Object.hasOwn(parsed.data, key)
      ? parsed.data[key].options
      : undefined;
    if (!choices || choices.includes(value as string))
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  for (const [key, config] of fields) {
    const value = Object.hasOwn(result, key) ? result[key] : undefined;
    if (value === undefined || value === '') {
      if (config.required)
        throw new Error(`Missing required Mod option: ${key}.`);
    } else {
      const valid =
        config.type === 'number'
          ? typeof value === 'number' &&
            (config.min === undefined || value >= config.min) &&
            (config.max === undefined || value <= config.max)
          : config.type === 'boolean'
            ? typeof value === 'boolean'
            : typeof value === 'string' ||
              (config.type === 'string' &&
                config.multiple &&
                Array.isArray(value));
      if (!valid) throw new Error(`Invalid Mod option: ${key}.`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MOD_MAX_BYTES) {
    throw new Error('Mod options exceed the 256 KiB limit.');
  }
  return result;
}
