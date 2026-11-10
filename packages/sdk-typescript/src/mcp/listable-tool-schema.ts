/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { toJSONSchema, z, type ZodObject, type ZodRawShape } from 'zod';

export function makeListableToolSchema<Schema extends ZodRawShape>(
  schema: Schema,
): ZodObject<Schema> {
  const objectSchema = z.object(schema);
  const listableSchema = z.object(schema);

  // Keep runtime validation unchanged while allowing discovery to represent
  // unrepresentable fields as unconstrained JSON Schema nodes.
  listableSchema._zod.toJSONSchema = () => {
    const jsonSchema = toJSONSchema(objectSchema, {
      target: 'draft-07',
      io: 'input',
      unrepresentable: 'any',
    });
    delete jsonSchema.$schema;
    return jsonSchema;
  };

  return listableSchema;
}
