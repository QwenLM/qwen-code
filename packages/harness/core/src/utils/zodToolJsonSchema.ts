/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

type JsonSchemaObject = Record<string, unknown>;

/**
 * Converts a Zod schema into the JSON Schema declared to the model for tool
 * arguments.
 *
 * The model sends tool input, so this converts the input side: defaulted
 * fields stay optional and transforms keep their input type. The output keeps
 * the shape the tool validators and transports already expect:
 * - draft-07 without `$schema`, matching the default AJV validator.
 * - Objects that strip unknown keys declare `additionalProperties: false`.
 * - No implicit safe-integer bounds on `.int()` or `propertyNames` on
 *   string-keyed records; Gemini rejects the latter.
 * - Unrepresentable types become `{}` instead of throwing.
 */
export function zodToToolJsonSchema(schema: z.ZodType): JsonSchemaObject {
  const { $schema: _$schema, ...jsonSchema } = z.toJSONSchema(schema, {
    target: 'draft-07',
    io: 'input',
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema }) => {
      const def = zodSchema._zod.def;
      const node = jsonSchema as JsonSchemaObject;
      if (def.type === 'object' && def.catchall === undefined) {
        node['additionalProperties'] = false;
      }
      if (node['minimum'] === Number.MIN_SAFE_INTEGER) delete node['minimum'];
      if (node['maximum'] === Number.MAX_SAFE_INTEGER) delete node['maximum'];
      const propertyNames = node['propertyNames'] as
        | JsonSchemaObject
        | undefined;
      if (
        propertyNames &&
        Object.keys(propertyNames).length === 1 &&
        propertyNames['type'] === 'string'
      ) {
        delete node['propertyNames'];
      }
    },
  });
  return jsonSchema;
}

/**
 * Converts `schema` as the single required property `name` of a tool's
 * argument object. Recursive schemas keep their `definitions` at the root, so
 * `$ref` targets still resolve after nesting.
 */
export function zodToToolPropertyJsonSchema(
  name: string,
  schema: z.ZodType,
): JsonSchemaObject {
  const wrapped = zodToToolJsonSchema(z.object({ [name]: schema }));
  const properties = wrapped['properties'] as JsonSchemaObject;
  return {
    type: 'object',
    properties: { [name]: properties[name] },
    required: [name],
    ...(wrapped['definitions'] ? { definitions: wrapped['definitions'] } : {}),
  };
}
