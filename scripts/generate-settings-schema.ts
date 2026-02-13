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
  SettingsSchema,
} from '../packages/cli/src/config/settingsSchema.js';
import { getSettingsSchema } from '../packages/cli/src/config/settingsSchema.js';

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
}

function convertSettingToJsonSchema(
  setting: SettingDefinition,
): JsonSchemaProperty {
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
      schema.items = { type: 'string' };
      break;
    case 'enum':
      if (setting.options && setting.options.length > 0) {
        schema.enum = setting.options.map((o) => o.value);
        schema.description +=
          ' Options: ' + setting.options.map((o) => `${o.value}`).join(', ');
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

  // Add default value for simple types only
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
    }
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

  // Add $version property
  jsonSchema.properties!['$version'] = {
    type: 'number',
    description: 'Settings schema version for migration tracking.',
    default: 3,
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
