/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type {
  SettingsDefinition,
  SettingsSchemaReferences,
  SettingsService,
} from '@qwen-code/resource';
import { getRemovedCustomProviderFieldMessage } from '@qwen-code/core';
import {
  getSettingsSchema,
  type SettingDefinition,
  type SettingCollectionDefinition,
  type SettingsSchema,
  SETTINGS_SCHEMA_REFERENCES,
} from './settingsSchema.js';

export function requireSettingsDefinition(
  service: SettingsService,
): Readonly<SettingsDefinition> {
  const definition = service.getDefinition();
  if (!definition) {
    throw new Error(
      'SettingsService must be configured with settings rules before resolving CLI settings',
    );
  }
  return definition;
}

interface NumberConstraints {
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  exclusiveMaximum?: number;
}

function buildNumberSchema(
  source?: NumberConstraints,
  integer = false,
): z.ZodNumber {
  let schema = integer ? z.number().int() : z.number();
  if (typeof source?.exclusiveMinimum === 'number') {
    schema = schema.gt(source.exclusiveMinimum);
  }
  if (typeof source?.minimum === 'number') {
    schema = schema.min(source.minimum);
  }
  if (typeof source?.exclusiveMaximum === 'number') {
    schema = schema.lt(source.exclusiveMaximum);
  }
  if (typeof source?.maximum === 'number') {
    schema = schema.max(source.maximum);
  }
  return schema;
}

type UnknownKeysMode = 'passthrough' | 'strip';
type ReferenceSchemas = Map<string, z.ZodTypeAny>;

// Helper to build Zod schema from the JSON-schema-like definitions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildZodSchemaFromJsonSchema(
  // oxlint-disable-next-line typescript/no-explicit-any
  def: any,
  refs: ReferenceSchemas,
  unknownKeysMode: UnknownKeysMode = 'passthrough',
): z.ZodTypeAny {
  // Lazy so a nested ref resolves regardless of declaration order in
  // this validator's registry, which is still being populated.
  if (typeof def.ref === 'string') {
    const ref: string = def.ref;
    return z.lazy(() => {
      const schema = refs.get(ref);
      if (!schema) throw new Error(`Unknown settings schema ref: ${ref}`);
      return schema;
    });
  }
  if (def.anyOf) {
    return z.union(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // oxlint-disable-next-line typescript/no-explicit-any
      def.anyOf.map((d: any) =>
        buildZodSchemaFromJsonSchema(d, refs, unknownKeysMode),
      ),
    );
  }

  if (def.type === 'string') {
    if (def.enum) return z.enum(def.enum as [string, ...string[]]);
    return z.string();
  }
  if (def.type === 'number') return buildNumberSchema(def);
  if (def.type === 'integer') return buildNumberSchema(def, true);
  if (def.type === 'boolean') {
    if (Array.isArray(def.enum) && def.enum.length === 1) {
      return z.literal(def.enum[0]);
    }
    return z.boolean();
  }

  if (def.type === 'array') {
    if (def.items) {
      return z.array(
        buildZodSchemaFromJsonSchema(def.items, refs, unknownKeysMode),
      );
    }
    return z.array(z.unknown());
  }

  if (def.type === 'object') {
    let schema;
    if (def.properties) {
      const shape: Record<string, z.ZodTypeAny> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // oxlint-disable-next-line typescript/no-explicit-any
      for (const [key, propDef] of Object.entries(def.properties) as any) {
        let propSchema = buildZodSchemaFromJsonSchema(
          propDef,
          refs,
          unknownKeysMode,
        );
        if (
          def.required &&
          Array.isArray(def.required) &&
          def.required.includes(key)
        ) {
          // keep it required
        } else {
          propSchema = propSchema.optional();
        }
        shape[key] = propSchema;
      }
      schema =
        unknownKeysMode === 'strip'
          ? z.object(shape).strip()
          : z.object(shape).passthrough();
    } else {
      schema = z.object({}).passthrough();
    }

    if (def.additionalProperties === false) {
      schema = schema.strict();
    } else if (typeof def.additionalProperties === 'object') {
      schema = schema.catchall(
        buildZodSchemaFromJsonSchema(
          def.additionalProperties,
          refs,
          unknownKeysMode,
        ),
      );
    }

    return schema;
  }

  return z.unknown();
}

/**
 * Builds a Zod enum schema from options array
 */
function buildEnumSchema(
  options: ReadonlyArray<{ value: string | number | boolean; label: string }>,
): z.ZodTypeAny {
  if (!options || options.length === 0) {
    throw new Error(
      `Enum type must have options defined. Check your settings schema definition.`,
    );
  }
  const values = options.map((opt) => opt.value);
  if (values.every((v) => typeof v === 'string')) {
    return z.enum(values as [string, ...string[]]);
  } else if (values.every((v) => typeof v === 'number')) {
    return z.union(
      values.map((v) => z.literal(v)) as [
        z.ZodLiteral<number>,
        z.ZodLiteral<number>,
        ...Array<z.ZodLiteral<number>>,
      ],
    );
  } else {
    return z.union(
      values.map((v) => z.literal(v)) as [
        z.ZodLiteral<unknown>,
        z.ZodLiteral<unknown>,
        ...Array<z.ZodLiteral<unknown>>,
      ],
    );
  }
}

/**
 * Builds a Zod object shape from properties record
 */
function buildObjectShapeFromProperties(
  properties: Record<string, SettingDefinition>,
  refs: ReferenceSchemas,
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, childDef] of Object.entries(properties)) {
    shape[key] = buildZodSchemaFromDefinition(childDef, refs);
  }
  return shape;
}

/**
 * Builds a Zod schema for primitive types (string, number, boolean)
 */
function buildPrimitiveSchema(
  type: 'string' | 'number' | 'boolean',
  constraints?: NumberConstraints,
): z.ZodTypeAny {
  switch (type) {
    case 'string':
      return z.string();
    case 'number':
      return buildNumberSchema(constraints);
    case 'boolean':
      return z.boolean();
    default:
      return z.unknown();
  }
}

function buildReferenceSchemas(
  references: SettingsSchemaReferences,
): ReferenceSchemas {
  const refs: ReferenceSchemas = new Map();
  for (const [name, def] of Object.entries(references.definitions)) {
    // Only declared fields should reach the runtime MCP client.
    let schema = buildZodSchemaFromJsonSchema(
      def,
      refs,
      name === 'MCPServerConfig' ? 'strip' : 'passthrough',
    );
    const validators = references.fieldValidators?.[name];
    if (validators) {
      schema = schema.superRefine((value, context) => {
        for (const [key, validate] of Object.entries(validators)) {
          const field = (value as Record<string, unknown>)[key];
          if (field === undefined) continue;
          try {
            validate(field);
          } catch (error) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });
    }
    refs.set(name, schema);
  }
  return refs;
}

/**
 * Recursively builds a Zod schema from a SettingDefinition
 */
function buildZodSchemaFromDefinition(
  definition: SettingDefinition,
  refs: ReferenceSchemas,
): z.ZodTypeAny {
  let baseSchema: z.ZodTypeAny;

  // Handle refs using registry
  const reference = definition.ref && refs.get(definition.ref);
  if (reference) return reference.optional();

  switch (definition.type) {
    case 'string':
    case 'number':
    case 'boolean':
      baseSchema = buildPrimitiveSchema(definition.type, definition);
      break;

    case 'enum': {
      baseSchema = buildEnumSchema(definition.options!);
      break;
    }

    case 'array':
      if (definition.items) {
        const itemSchema = buildZodSchemaFromCollection(definition.items, refs);
        baseSchema = z.array(itemSchema);
      } else {
        baseSchema = z.array(z.unknown());
      }
      break;

    case 'object':
      if (definition.properties) {
        const shape = buildObjectShapeFromProperties(
          definition.properties,
          refs,
        );
        baseSchema = z.object(shape).passthrough();

        if (definition.additionalProperties) {
          const additionalSchema = buildZodSchemaFromCollection(
            definition.additionalProperties,
            refs,
          );
          baseSchema = z.object(shape).catchall(additionalSchema);
        }
      } else if (definition.additionalProperties) {
        const valueSchema = buildZodSchemaFromCollection(
          definition.additionalProperties,
          refs,
        );
        baseSchema = z.record(z.string(), valueSchema);
      } else {
        baseSchema = z.record(z.string(), z.unknown());
      }
      break;

    default:
      baseSchema = z.unknown();
  }

  // Make all fields optional since settings are partial
  return baseSchema.optional();
}

/**
 * Builds a Zod schema from a SettingCollectionDefinition
 */
function buildZodSchemaFromCollection(
  collection: SettingCollectionDefinition,
  refs: ReferenceSchemas,
): z.ZodTypeAny {
  const reference = collection.ref && refs.get(collection.ref);
  if (reference) return reference;

  switch (collection.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return buildPrimitiveSchema(collection.type, collection);

    case 'enum': {
      return buildEnumSchema(collection.options!);
    }

    case 'array':
      if (collection.properties) {
        const shape = buildObjectShapeFromProperties(
          collection.properties,
          refs,
        );
        return z.array(z.object(shape));
      }
      return z.array(z.unknown());

    case 'object':
      if (collection.properties) {
        const shape = buildObjectShapeFromProperties(
          collection.properties,
          refs,
        );
        const schema = z.object(shape).passthrough();
        const forbiddenProperties = collection.forbiddenProperties;
        if (!forbiddenProperties?.length) return schema;
        return schema.superRefine((value, context) => {
          for (const key of forbiddenProperties) {
            if (!(key in value)) continue;
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: getRemovedCustomProviderFieldMessage(key),
            });
          }
        });
      }
      return z.record(z.string(), z.unknown());

    default:
      return z.unknown();
  }
}

/**
 * Builds the complete Zod schema for Settings from SETTINGS_SCHEMA
 */
function buildSettingsZodSchema(
  schema: SettingsSchema,
  references: SettingsSchemaReferences,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const refs = buildReferenceSchemas(references);

  for (const [key, definition] of Object.entries(schema)) {
    shape[key] = buildZodSchemaFromDefinition(definition, refs);
  }

  return z.object(shape).passthrough();
}

const validationSchemas = new WeakMap<
  SettingsSchema,
  WeakMap<SettingsSchemaReferences, z.ZodObject<Record<string, z.ZodTypeAny>>>
>();

/** Cache validators independently for each service schema. */
export function getSettingsZodSchema(
  schema: SettingsSchema = getSettingsSchema(),
  references: SettingsSchemaReferences = SETTINGS_SCHEMA_REFERENCES,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  let validators = validationSchemas.get(schema);
  if (!validators) {
    validators = new WeakMap();
    validationSchemas.set(schema, validators);
  }
  let validation = validators.get(references);
  if (!validation) {
    validation = buildSettingsZodSchema(schema, references);
    validators.set(references, validation);
  }
  return validation;
}

/**
 * Validates settings data against the Zod schema
 */
export function validateSettings(
  data: unknown,
  schema: SettingsSchema = getSettingsSchema(),
): {
  success: boolean;
  data?: unknown;
  error?: z.ZodError;
} {
  const result = getSettingsZodSchema(schema).safeParse(data);
  return result;
}

/**
 * Format a Zod error into a helpful error message
 */
export function formatValidationError(
  error: z.ZodError,
  filePath: string,
): string {
  const lines: string[] = [];
  lines.push(`Invalid configuration in ${filePath}:`);
  lines.push('');

  const MAX_ERRORS_TO_DISPLAY = 5;
  const displayedIssues = error.issues.slice(0, MAX_ERRORS_TO_DISPLAY);

  for (const issue of displayedIssues) {
    const path = issue.path.reduce(
      (acc, curr) =>
        typeof curr === 'number'
          ? `${acc}[${curr}]`
          : `${acc ? acc + '.' : ''}${curr}`,
      '',
    );
    lines.push(`Error in: ${path || '(root)'}`);
    lines.push(`    ${issue.message}`);

    if (issue.code === 'invalid_type') {
      const expected = issue.expected;
      const received = issue.received;
      lines.push(`Expected: ${expected}, but received: ${received}`);
    }
    lines.push('');
  }

  if (error.issues.length > MAX_ERRORS_TO_DISPLAY) {
    lines.push(
      `...and ${error.issues.length - MAX_ERRORS_TO_DISPLAY} more errors.`,
    );
    lines.push('');
  }

  lines.push('Please fix the configuration.');
  lines.push('See the settings documentation for details.');

  return lines.join('\n');
}
