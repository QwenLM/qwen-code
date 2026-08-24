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
        target['type'] = types.find((t) => t !== 'null') ?? types[0];
        if (types.includes('null')) {
          target['nullable'] = true;
        }
      }
    } else if (source['type'] !== undefined) {
      target['type'] = source['type'];
    }

    // 2. Const Handling (Draft 6+) -> Enum (OpenAPI 3.0)
    // Stringified for the same reason step 5 stringifies `enum`: this
    // produces an enum, and Gemini requires those to be strings. Step 5
    // cannot cover it, since it keys off `source['enum']`, which a
    // const-only schema never sets.
    if (source['const'] !== undefined) {
      target['enum'] = [String(source['const'])];
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
      // `properties` / `$defs` / `definitions` are name->schema MAPS: their
      // keys are property/definition names, not JSON Schema keywords. Walking
      // one as if it were a schema node makes every step above misfire on a
      // property whose name collides with a keyword — a property called
      // `const` is replaced by a bogus `enum`, one called `default` is
      // dropped by the skip list below, and one called `type` is copied
      // verbatim instead of being converted. Only the VALUES are schemas.
      if (
        (key === 'properties' || key === '$defs' || key === 'definitions') &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        const map: Record<string, unknown> = {};
        for (const [mapKey, mapValue] of Object.entries(
          value as Record<string, unknown>,
        )) {
          map[mapKey] = convert(mapValue);
        }
        target[key] = map;
        continue;
      }

      // Skip fields we've already handled or want to remove
      if (
        key === 'type' ||
        key === 'const' ||
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

      // Step 3 consumes only the NUMERIC form of the exclusive limits, so
      // only the numeric form may be skipped here. A boolean is a Draft 4
      // schema that already carries the exact shape step 3 emits, and
      // skipping it unconditionally dropped it: `{minimum: 10,
      // exclusiveMinimum: true}` came back as `{minimum: 10}`, silently
      // relaxing `> 10` into `>= 10`. That also made this function
      // non-idempotent — feeding its own output back in lost the flag it had
      // just added.
      if (
        (key === 'exclusiveMinimum' || key === 'exclusiveMaximum') &&
        typeof value === 'number'
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

/**
 * Relaxes a tool-parameter JSON Schema for the OpenAI-compatible wire
 * format (#7315).
 *
 * OpenAI's structured-output contract requires that when an object schema
 * carries `additionalProperties: false`, every property must be listed in
 * `required`; several OpenAI-compatible gateways enforce this server-side
 * by silently promoting ALL properties to required. For tools with
 * genuinely optional fields the model is then forced to emit every field
 * on every call — the Agent tool's mutually exclusive `working_dir` and
 * `isolation` become impossible to satisfy, and the model loops on the
 * client-side validation error until loop detection kills the run.
 *
 * The relaxation is deliberately surgical:
 * - `additionalProperties: false` is removed ONLY on object levels that
 *   declare optional properties (some `properties` key missing from
 *   `required`). Levels where every property is required keep the
 *   constraint — there is nothing for a gateway to promote.
 * - `$schema` / `$id` metadata is dropped at every schema level (some
 *   gateways reject unknown keywords).
 * - `uniqueItems` is dropped at every schema level because some
 *   OpenAI-compatible function-calling endpoints reject it.
 * - Other constraints pass through untouched; client-side
 *   `validateToolParams` still enforces the full source schema, so the
 *   constraint is relaxed on the wire only.
 *
 * Pure: returns new objects, never mutates the input.
 */
export function relaxSchemaForFunctionCalling(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const relax = (obj: unknown): unknown => {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(relax);
    }
    const source = obj as Record<string, unknown>;
    const target: Record<string, unknown> = {};

    const properties = source['properties'];
    const required = Array.isArray(source['required'])
      ? (source['required'] as unknown[]).filter(
          (r): r is string => typeof r === 'string',
        )
      : [];
    const hasOptionalProperties =
      typeof properties === 'object' &&
      properties !== null &&
      !Array.isArray(properties) &&
      Object.keys(properties).some((key) => !required.includes(key));

    for (const [key, value] of Object.entries(source)) {
      if (key === '$schema' || key === '$id' || key === 'uniqueItems') {
        continue;
      }
      if (
        key === 'additionalProperties' &&
        value === false &&
        hasOptionalProperties
      ) {
        continue;
      }
      // These keywords contain JSON values, not nested schemas.
      if (
        key === 'const' ||
        key === 'default' ||
        key === 'enum' ||
        key === 'example' ||
        key === 'examples'
      ) {
        target[key] = structuredClone(value);
        continue;
      }
      // These keywords are name->schema/value maps: their keys are names, not
      // JSON Schema keywords. A map entry literally named `$schema`,
      // `uniqueItems`, or `additionalProperties` must survive — only the
      // values are schemas to relax.
      if (
        (key === 'properties' ||
          key === 'patternProperties' ||
          key === '$defs' ||
          key === 'definitions' ||
          key === 'dependencies' ||
          key === 'dependentSchemas' ||
          key === 'dependentRequired') &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        const map: Record<string, unknown> = {};
        for (const [mapKey, mapValue] of Object.entries(
          value as Record<string, unknown>,
        )) {
          map[mapKey] = relax(mapValue);
        }
        target[key] = map;
        continue;
      }
      target[key] = relax(value);
    }
    return target;
  };

  return relax(schema) as Record<string, unknown>;
}
