/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ZodRawShape, type ZodType } from 'zod';

function makeListableField<Schema extends ZodType>(schema: Schema): Schema {
  try {
    schema.toJSONSchema({ target: 'draft-07', io: 'input' });
    return schema;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes('cannot be represented in JSON Schema')
    ) {
      throw error;
    }
  }

  const clone = schema.clone(schema._zod.def);
  // MCP uses Zod's strict JSON Schema conversion for discovery. Preserve the
  // runtime parser while advertising an unconstrained field for types such as
  // z.custom(), which have no JSON Schema equivalent.
  clone._zod.toJSONSchema = () => ({});
  return clone;
}

export function makeListableToolSchema<Schema extends ZodRawShape>(
  schema: Schema,
): Schema {
  return Object.fromEntries(
    Object.entries(schema).map(([name, field]) => [
      name,
      makeListableField(field as ZodType),
    ]),
  ) as unknown as Schema;
}
