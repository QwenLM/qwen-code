/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utility for converting JSON Schemas to be compatible with different LLM providers.
 * Specifically focuses on downgrading modern JSON Schema (Draft 7/2020-12) to
 * OpenAPI 3.0 compatible Schema Objects, which is required for Google Gemini API.
 */

export type SchemaComplianceMode = 'auto' | 'openapi_30';

/**
 * Converts a JSON Schema to be compatible with the specified compliance mode.
 */
export function convertSchema(
  schema: Record<string, unknown>,
  mode: SchemaComplianceMode = 'auto',
): Record<string, unknown> {
  if (mode === 'openapi_30') {
    return toOpenAPI30(schema);
  }

  // Default ('auto') mode now does nothing.
  return schema;
}

/**
 * Converts Modern JSON Schema to OpenAPI 3.0 Schema Object.
 * Attempts to preserve semantics where possible through transformations.
 */
function toOpenAPI30(schema: Record<string, unknown>): Record<string, unknown> {
  const convert = (obj: unknown): unknown => {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(convert);
    }

    const source = obj as Record<string, unknown>;
    const target: Record<string, unknown> = {};

    // 1. Type Handling
    if (Array.isArray(source['type'])) {
      const types = source['type'] as string[];
      // Handle ["string", "null"] pattern common in modern schemas
      if (types.length === 2 && types.includes('null')) {
        target['type'] = types.find((t) => t !== 'null');
        target['nullable'] = true;
      } else {
        // Fallback for other unions: take the first non-null type
        // OpenAPI 3.0 doesn't support type arrays.
        // Ideal fix would be anyOf, but simple fallback is safer for now.
        target['type'] = types[0];
      }
    } else if (source['type'] !== undefined) {
      target['type'] = source['type'];
    }

    // 2. Const Handling (Draft 6+) -> Enum (OpenAPI 3.0)
    if (source['const'] !== undefined) {
      target['enum'] = [source['const']];
      delete target['const'];
    }

    // 3. Exclusive Limits (Draft 6+ number) -> (Draft 4 boolean)
    // exclusiveMinimum: 10 -> minimum: 10, exclusiveMinimum: true
    if (typeof source['exclusiveMinimum'] === 'number') {
      target['minimum'] = source['exclusiveMinimum'];
      target['exclusiveMinimum'] = true;
    }
    if (typeof source['exclusiveMaximum'] === 'number') {
      target['maximum'] = source['exclusiveMaximum'];
      target['exclusiveMaximum'] = true;
    }

    // 4. Array Items (Tuple -> Single Schema)
    // OpenAPI 3.0 items must be a schema object, not an array of schemas
    if (Array.isArray(source['items'])) {
      // Tuple support is tricky.
      // Best effort: Use the first item's schema as a generic array type
      // or convert to an empty object (any type) if mixed.
      // For now, we'll strip it to allow validation to pass (accepts any items)
      // This matches the legacy behavior but is explicit.
      // Ideally, we could use `oneOf` on the items if we wanted to be stricter.
      delete target['items'];
    } else if (
      typeof source['items'] === 'object' &&
      source['items'] !== null
    ) {
      target['items'] = convert(source['items']);
    }

    // 5. Enum Stringification
    // Gemini strictly requires enums to be strings
    if (Array.isArray(source['enum'])) {
      target['enum'] = source['enum'].map(String);
    }

    // 6. Recursively process other properties
    for (const [key, value] of Object.entries(source)) {
      // Skip fields we've already handled or want to remove
      if (
        key === 'type' ||
        key === 'const' ||
        key === 'exclusiveMinimum' ||
        key === 'exclusiveMaximum' ||
        key === 'items' ||
        key === 'enum' ||
        key === '$schema' ||
        key === '$id' ||
        key === 'default' || // Optional: Gemini sometimes complains about defaults conflicting with types
        key === 'dependencies' ||
        key === 'patternProperties'
      ) {
        continue;
      }

      target[key] = convert(value);
    }

    // Preserve default if it doesn't conflict (simple pass-through)
    // if (source['default'] !== undefined) {
    //   target['default'] = source['default'];
    // }

    return target;
  };

  return convert(schema) as Record<string, unknown>;
}
