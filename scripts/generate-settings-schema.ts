/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Generates a JSON Schema from the internal SETTINGS_SCHEMA definition.
 *
 * Usage: npx tsx scripts/generate-settings-schema.ts
 *
 * This reads the TypeScript settings schema and converts it to a standard
 * JSON Schema file that VS Code uses for IntelliSense in settings.json files.
 *
 * Prerequisites: npm run build (core package must be built first)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  SettingDefinition,
  SettingItemDefinition,
  SettingsSchema,
} from '../packages/cli/src/config/settingsSchema.js';
import { getSettingsSchema } from '../packages/cli/src/config/settingsSchema.js';
import { SETTINGS_VERSION } from '../packages/cli/src/config/settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface JsonSchemaProperty {
  $schema?: string;
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  enum?: (string | number)[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchemaProperty;
  required?: string[];
  oneOf?: JsonSchemaProperty[];
  anyOf?: JsonSchemaProperty[];
  allOf?: JsonSchemaProperty[];
}

function convertItemDefinitionToJsonSchema(
  itemDef: SettingItemDefinition,
): JsonSchemaProperty {
  const schema: JsonSchemaProperty = {};

  if (itemDef.description) {
    schema.description = itemDef.description;
  }

  schema.type = itemDef.type;

  if (itemDef.enum) {
    schema.enum = itemDef.enum;
  }

  if (itemDef.type === 'object' && itemDef.properties) {
    schema.properties = {};
    const requiredFields: string[] = [];

    for (const [key, childDef] of Object.entries(itemDef.properties)) {
      const childSchema = convertItemDefinitionToJsonSchema(childDef);
      schema.properties[key] = childSchema;
      if (childDef.required) {
        requiredFields.push(key);
      }
    }

    if (requiredFields.length > 0) {
      schema.required = requiredFields;
    }
  }

  if (itemDef.type === 'object' && itemDef.additionalProperties !== undefined) {
    if (typeof itemDef.additionalProperties === 'boolean') {
      schema.additionalProperties = itemDef.additionalProperties;
    } else {
      schema.additionalProperties = convertItemDefinitionToJsonSchema(
        itemDef.additionalProperties,
      );
    }
  }

  if (itemDef.items) {
    schema.type = 'array';
    schema.items = convertItemDefinitionToJsonSchema(itemDef.items);
  }

  return schema;
}

function convertSettingToJsonSchema(
  setting: SettingDefinition,
): JsonSchemaProperty {
  // Escape hatch: a SettingDefinition can supply a verbatim JSON Schema
  // fragment for cases the `type` field cannot express (most commonly
  // unions). The description is carried forward from the SettingDefinition
  // so we don't have to restate it in the override.
  if (setting.jsonSchemaOverride) {
    const override = { ...setting.jsonSchemaOverride } as JsonSchemaProperty;
    if (setting.description && override.description === undefined) {
      override.description = setting.description;
    }
    return override;
  }

  const schema: JsonSchemaProperty = {};

  if (setting.description) {
    schema.description = setting.description;
  }

  switch (setting.type) {
    case 'boolean':
      schema.type = 'boolean';
      break;
    case 'string':
      schema.type = 'string';
      break;
    case 'number':
      schema.type = 'number';
      break;
    case 'array':
      schema.type = 'array';
      if (setting.items) {
        schema.items = convertItemDefinitionToJsonSchema(setting.items);
      } else {
        schema.items = { type: 'string' };
      }
      break;
    case 'enum':
      if (setting.options && setting.options.length > 0) {
        schema.enum = setting.options.map((o) => o.value);
        const optionsText =
          'Options: ' + setting.options.map((o) => `${o.value}`).join(', ');
        schema.description = schema.description
          ? `${schema.description} ${optionsText}`
          : optionsText;
      } else {
        // Enum without predefined options - accept any string
        schema.type = 'string';
      }
      break;
    case 'object':
      schema.type = 'object';
      if (setting.properties) {
        schema.properties = {};
        for (const [key, childDef] of Object.entries(setting.properties)) {
          schema.properties[key] = convertSettingToJsonSchema(
            childDef as SettingDefinition,
          );
        }
      } else {
        schema.additionalProperties = true;
      }
      break;
  }

  // Add default value for simple and object types
  if (setting.default !== undefined && setting.default !== null) {
    const defaultVal = setting.default;
    if (
      typeof defaultVal === 'boolean' ||
      typeof defaultVal === 'number' ||
      typeof defaultVal === 'string'
    ) {
      schema.default = defaultVal;
    } else if (Array.isArray(defaultVal) && defaultVal.length > 0) {
      schema.default = defaultVal;
    } else if (
      typeof defaultVal === 'object' &&
      !Array.isArray(defaultVal) &&
      Object.keys(defaultVal).length > 0
    ) {
      // Non-empty plain object — publish so IDE editors can surface the
      // default value (e.g. `{commit: true, pr: true}` for gitCoAuthor).
      schema.default = defaultVal;
    }
  }

  // If the field accepts a legacy primitive shape (e.g. a boolean that was
  // later expanded into an object), wrap with `anyOf` so existing values
  // in users' settings.json don't trip the IDE schema validator while
  // they wait for our migration to rewrite them on the next launch.
  //
  // Lift `description` and `default` to the outer (anyOf) level so IDE
  // editors that surface schema-driven defaults / descriptions still see
  // them — burying these behind `anyOf[N]` makes most validators ignore
  // the `default`, which loses the "enabled by default" hint for any
  // setting using `legacyTypes`.
  if (setting.legacyTypes && setting.legacyTypes.length > 0) {
    const description = schema.description;
    const defaultVal = schema.default;
    delete schema.description;
    delete schema.default;
    return {
      ...(description ? { description } : {}),
      ...(defaultVal !== undefined ? { default: defaultVal } : {}),
      anyOf: [...setting.legacyTypes.map((t) => ({ type: t })), schema],
    };
  }

  return schema;
}

function generateJsonSchema(
  settingsSchema: SettingsSchema,
): JsonSchemaProperty {
  const jsonSchema: JsonSchemaProperty = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    description: 'Qwen Code settings configuration',
    properties: {},
    additionalProperties: true,
  };

  for (const [key, setting] of Object.entries(settingsSchema)) {
    jsonSchema.properties![key] = convertSettingToJsonSchema(
      setting as SettingDefinition,
    );
  }

  // Add $version property — sourced from settings.ts so a SETTINGS_VERSION
  // bump propagates here instead of needing a parallel manual edit.
  jsonSchema.properties!['$version'] = {
    type: 'number',
    description: 'Settings schema version for migration tracking.',
    default: SETTINGS_VERSION,
  };

  return jsonSchema;
}

const schema = getSettingsSchema();
const jsonSchema = generateJsonSchema(schema as unknown as SettingsSchema);

const outputDir = path.resolve(
  __dirname,
  '../packages/vscode-ide-companion/schemas',
);
const outputPath = path.join(outputDir, 'settings.schema.json');

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2) + '\n');

console.log(`Generated settings JSON Schema at: ${outputPath}`);
