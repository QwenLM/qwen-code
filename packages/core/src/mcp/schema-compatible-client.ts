/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  AnySchema,
  SchemaOutput,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import {
  ListToolsResultSchema,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';

// SDK 1.29 rejects boolean schemas in outputSchema.properties before its
// JSON Schema validator runs. Both true and false are valid JSON Schema;
// preserve them so output validation retains their original meaning.
// Remove this workaround once the locked SDK accepts boolean property schemas
// natively; keep the two-entry-point and output-validation regression tests.
// SDK schema-shape changes should fail those tests during dependency upgrades.
const compatibleOutputSchema = ToolSchema.shape.outputSchema.unwrap().extend({
  properties: z
    .record(
      z.string(),
      z.union([z.record(z.string(), z.unknown()), z.boolean()]),
    )
    .optional(),
});
const compatibleListToolsResultSchema = ListToolsResultSchema.extend({
  tools: z.array(
    ToolSchema.extend({ outputSchema: compatibleOutputSchema.optional() }),
  ),
});

/** Narrow compatibility at the response boundary, shared by both MCP hosts. */
export class SchemaCompatibleMcpClient extends Client {
  override request<T extends AnySchema>(
    request: Parameters<Client['request']>[0],
    resultSchema: T,
    options?: RequestOptions,
  ): Promise<SchemaOutput<T>> {
    if (
      request.method === 'tools/list' &&
      Object.is(resultSchema, ListToolsResultSchema)
    ) {
      // Keep Client.listTools() intact: it caches output validators and task
      // metadata after this request, including on later list refreshes.
      // SDK's static output type still describes property schemas as objects.
      // At runtime this narrow boundary also permits booleans; consumers must
      // treat them as JSON Schema values rather than dereferencing them.
      return super.request(
        request,
        compatibleListToolsResultSchema,
        options,
      ) as Promise<SchemaOutput<T>>;
    }
    return super.request(request, resultSchema, options);
  }
}
