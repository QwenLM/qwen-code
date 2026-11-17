/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { toJSONSchema, z, type ZodObject, type ZodRawShape } from 'zod';

function isZodV4Field(field: unknown): boolean {
  return typeof field === 'object' && field !== null && '_zod' in field;
}

function isZodV4Shape(schema: ZodRawShape): boolean {
  return Object.values(schema).every(isZodV4Field);
}

export function makeListableToolSchema<Schema extends ZodRawShape>(
  schema: Schema,
): Schema | ZodObject<Schema> {
  // Only Zod 4 (classic and Mini) fields expose `_zod`. Everything else — Zod
  // v3 fields, and shapes this helper does not recognise — goes back untouched
  // so MCP's own zod-compat layer keeps handling it, as it did before this
  // helper knew about schema flavours at all.
  if (!isZodV4Shape(schema)) {
    return schema;
  }

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
