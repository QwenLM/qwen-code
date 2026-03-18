/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type VariableSchema, VARIABLE_SCHEMA } from './variableSchema.js';
import path from 'node:path';
import { QWEN_DIR } from '../config/storage.js';
import type { HookEventName, HookDefinition } from '../hooks/types.js';

// Re-export types for substituteHookVariables
export type { HookEventName, HookDefinition };

export const EXTENSIONS_DIRECTORY_NAME = path.join(QWEN_DIR, 'extensions');
export const EXTENSIONS_CONFIG_FILENAME = 'qwen-extension.json';
export const INSTALL_METADATA_FILENAME = '.qwen-extension-install.json';
export const EXTENSION_SETTINGS_FILENAME = '.env';

export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray;

export type VariableContext = {
  [key in keyof typeof VARIABLE_SCHEMA]?: string;
};

export function validateVariables(
  variables: VariableContext,
  schema: VariableSchema,
) {
  for (const key in schema) {
    const definition = schema[key];
    if (definition.required && !variables[key as keyof VariableContext]) {
      throw new Error(`Missing required variable: ${key}`);
    }
  }
}

export function hydrateString(str: string, context: VariableContext): string {
  validateVariables(context, VARIABLE_SCHEMA);
  const regex = /\${(.*?)}/g;
  return str.replace(regex, (match, key) =>
    context[key as keyof VariableContext] == null
      ? match
      : (context[key as keyof VariableContext] as string),
  );
}

export function recursivelyHydrateStrings(
  obj: JsonValue,
  values: VariableContext,
): JsonValue {
  if (typeof obj === 'string') {
    return hydrateString(obj, values);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => recursivelyHydrateStrings(item, values));
  }
  if (typeof obj === 'object' && obj !== null) {
    const newObj: JsonObject = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        newObj[key] = recursivelyHydrateStrings(obj[key], values);
      }
    }
    return newObj;
  }
  return obj;
}

/**
 * Substitute variables in hook configurations, particularly ${CLAUDE_PLUGIN_ROOT}
 * @param hooks - The hooks configuration object
 * @param basePath - The path to substitute for ${CLAUDE_PLUGIN_ROOT}
 * @returns A deep cloned hooks object with variables substituted
 */
export function substituteHookVariables(
  hooks: { [K in HookEventName]?: HookDefinition[] } | undefined,
  basePath: string,
): { [K in HookEventName]?: HookDefinition[] } | undefined {
  if (!hooks) return hooks;

  // Deep clone the hooks to avoid modifying the original
  const clonedHooks = JSON.parse(JSON.stringify(hooks));

  // Replace ${CLAUDE_PLUGIN_ROOT} with the actual extension path in all command hooks
  for (const eventName in clonedHooks) {
    const eventHooks = clonedHooks[eventName as HookEventName];
    if (eventHooks && Array.isArray(eventHooks)) {
      for (const hookDef of eventHooks) {
        if (hookDef.hooks && Array.isArray(hookDef.hooks)) {
          for (const hook of hookDef.hooks) {
            if (hook.type === 'command' && hook.command) {
              hook.command = hook.command.replace(
                /\$\{CLAUDE_PLUGIN_ROOT\}/g,
                basePath,
              );
            }
          }
        }
      }
    }
  }

  return clonedHooks;
}
