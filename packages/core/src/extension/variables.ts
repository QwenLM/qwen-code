/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type VariableSchema, VARIABLE_SCHEMA } from './variableSchema.js';
import path from 'node:path';
import { QWEN_DIR } from '../config/storage.js';
import type { HookDefinition } from '../hooks/types.js';
import type { HookEventName } from '../hooks/types.js';
import * as fs from 'node:fs';
import { glob } from 'glob';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('Extension:variables');

// Re-export types for substituteHookVariables
export type { HookDefinition };

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

/**
 * Perform variable replacement in all markdown and shell script files of the extension.
 * This is done during the conversion phase to avoid modifying files during every extension load.
 * @param extensionPath - The path to the extension directory
 */
export function performVariableReplacement(extensionPath: string): void {
  // Process markdown files
  const mdGlobPattern = '**/*.md';
  const mdGlobOptions = {
    cwd: extensionPath,
    nodir: true,
  };

  try {
    const mdFiles = glob.sync(mdGlobPattern, mdGlobOptions);

    for (const file of mdFiles) {
      const filePath = path.join(extensionPath, file);

      try {
        const content = fs.readFileSync(filePath, 'utf8');

        // Replace ${CLAUDE_PLUGIN_ROOT} with the actual extension path
        const updatedContent = content.replace(
          /\$\{CLAUDE_PLUGIN_ROOT\}/g,
          extensionPath,
        );

        // Replace Markdown shell syntax ```! ... ``` with system-recognized !{...} syntax
        // This regex finds code blocks with ! language identifier and captures their content
        const syntaxUpdatedContent = updatedContent.replace(
          /```!(?:\s*\n)?([\s\S]*?)\n*```/g,
          '!{$1}',
        );

        // Replace references to ".claude" directory with ".qwen" in markdown files
        // Only match path references (e.g., ~/.claude/, $HOME/.claude, ./.claude/)
        // Avoid matching URLs, comments, or string literals containing .claude
        const updatedMdContent = syntaxUpdatedContent.replace(
          /(\$\{?HOME\}?\/|~\/)?\.claude(\/|$)/g,
          '$1.qwen$2',
        );

        // Only write if content was actually changed
        if (updatedMdContent !== content) {
          fs.writeFileSync(filePath, updatedMdContent, 'utf8');
          debugLogger.debug(
            `Updated variables, syntax, and .claude paths in file: ${filePath}`,
          );
        }
      } catch (error) {
        debugLogger.warn(
          `Failed to process file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    debugLogger.warn(
      `Failed to scan markdown files in extension directory ${extensionPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Process shell script files
  const scriptGlobPattern = '**/*.sh';
  const scriptGlobOptions = {
    cwd: extensionPath,
    nodir: true,
  };

  try {
    const scriptFiles = glob.sync(scriptGlobPattern, scriptGlobOptions);

    for (const file of scriptFiles) {
      const filePath = path.join(extensionPath, file);

      try {
        const content = fs.readFileSync(filePath, 'utf8');

        // Replace references to "role":"assistant" with "type":"assistant" in shell scripts
        const updatedScriptContent = content.replace(
          /"role":"assistant"/g,
          '"type":"assistant"',
        );

        // Replace transcript parsing logic to adapt to actual transcript structure
        // Change from .message.content | map(select(.type == "text")) to .message.parts | map(select(has("text")))
        const adaptedScriptContent = updatedScriptContent.replace(
          /\.message\.content\s*\|\s*map\(select\(\.type\s*==\s*"text"\)\)/g,
          '.message.parts | map(select(has("text")))',
        );

        // Replace references to ".claude" directory with ".qwen" in shell scripts
        // Only match path references (e.g., ~/.claude/, $HOME/.claude, ./.claude/)
        // Avoid matching URLs, comments, or string literals containing .claude
        const finalScriptContent = adaptedScriptContent.replace(
          /(\$\{?HOME\}?\/|~\/)?\.claude(\/|$)/g,
          '$1.qwen$2',
        );

        // Only write if content was actually changed
        if (finalScriptContent !== content) {
          fs.writeFileSync(filePath, finalScriptContent, 'utf8');
          debugLogger.debug(
            `Updated transcript format and replaced .claude with .qwen in shell script: ${filePath}`,
          );
        }
      } catch (error) {
        debugLogger.warn(
          `Failed to process shell script file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    debugLogger.warn(
      `Failed to scan shell script files in extension directory ${extensionPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
