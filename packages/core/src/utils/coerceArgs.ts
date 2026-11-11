/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Coerce tool argument values to match the types declared in the JSON Schema.
 *
 * LLMs frequently output values as strings — `"1"` instead of `1`,
 * `"true"` instead of `true`, or JSON-encoded arrays/objects. This module
 * performs best-effort, silent coercion so tools receive correctly-typed
 * arguments.
 */

type CoerceMode = 'full' | 'container-only';

/**
 * Walk `args` and coerce each value to the type declared in `properties`.
 * Unknown keys (not in properties) are passed through unchanged.
 */
export function coerceArgsToSchema(
  args: Record<string, unknown> | undefined,
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return coerceArgsToSchemaInternal(args, properties, 'full');
}

/**
 * Walk `args` and parse only JSON-encoded array/object containers declared in
 * `properties`. Scalar values are left unchanged for AJV to validate/coerce.
 */
export function coerceContainerArgsToSchema(
  args: Record<string, unknown> | undefined,
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return coerceArgsToSchemaInternal(args, properties, 'container-only');
}

function coerceArgsToSchemaInternal(
  args: Record<string, unknown> | undefined,
  properties: Record<string, unknown> | undefined,
  mode: CoerceMode,
): Record<string, unknown> | undefined {
  if (!args || !properties) return args;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const propDef = properties[key];
    if (!propDef || typeof propDef !== 'object') {
      result[key] = value;
      continue;
    }
    result[key] = coerceValue(value, propDef as Record<string, unknown>, mode);
  }
  return result;
}

function coerceValue(
  value: unknown,
  propSchema: Record<string, unknown>,
  mode: CoerceMode,
): unknown {
  if (value == null) return value;

  // Select a matching union member without skipping recursion into containers.
  // Both modes preserve scalar union members; only full mode coerces scalars.
  const schemaType = getSchemaType(propSchema, value);

  switch (schemaType) {
    case 'string':
      return mode === 'full' ? coerceToString(value) : value;
    case 'integer':
      return mode === 'full' ? coerceToInteger(value) : value;
    case 'number':
      return mode === 'full' ? coerceToNumber(value) : value;
    case 'boolean':
      return mode === 'full' ? coerceToBoolean(value) : value;
    case 'array':
      return coerceArray(value, propSchema, mode);
    case 'object':
      return coerceObject(value, propSchema, mode);
    default:
      return value;
  }
}

/**
 * Extract the effective type string from a JSON Schema property definition.
 * Handles both `"type": "string"` and union forms like `"type": ["string", "null"]`.
 */
function getSchemaType(
  propSchema: Record<string, unknown>,
  value: unknown,
): string {
  const typeVal = propSchema['type'];
  if (typeof typeVal === 'string') return typeVal;

  // Prefer the value's existing type, so union member order cannot flip it.
  // If no member matches, retain the first non-null type as the coercion target.
  if (Array.isArray(typeVal)) {
    const valueTypes = getJsonSchemaTypeNames(value);
    const matchingType = typeVal.find(
      (member) => typeof member === 'string' && valueTypes.includes(member),
    );
    if (typeof matchingType === 'string') return matchingType;

    for (const v of typeVal) {
      if (typeof v === 'string' && v !== 'null') return v;
    }
  }
  return '';
}

/**
 * Map a runtime value to the JSON Schema type names it natively satisfies.
 * An integral number satisfies both "number" and "integer".
 */
function getJsonSchemaTypeNames(value: unknown): string[] {
  if (typeof value === 'string') return ['string'];
  if (typeof value === 'boolean') return ['boolean'];
  if (typeof value === 'number') {
    return Number.isInteger(value) ? ['number', 'integer'] : ['number'];
  }
  if (Array.isArray(value)) return ['array'];
  if (typeof value === 'object') return ['object'];
  return [];
}

function coerceToInteger(value: unknown): unknown {
  if (typeof value === 'string') {
    const i = parseInt(value, 10);
    if (!Number.isNaN(i) && String(i) === value) return i;
    // Handle "1.0" → truncate to integer
    const f = parseFloat(value);
    if (Number.isFinite(f)) return Math.trunc(f);
    return value;
  }
  return value;
}

function coerceToNumber(value: unknown): unknown {
  if (typeof value === 'string') {
    const f = parseFloat(value);
    if (Number.isFinite(f)) return f;
    return value;
  }
  return value;
}

function coerceToBoolean(value: unknown): unknown {
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case '1':
      case 'yes':
        return true;
      case 'false':
      case '0':
      case 'no':
        return false;
      default:
        return value;
    }
  }
  return value;
}

function coerceToString(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  return value;
}

/**
 * Try to parse a JSON-encoded string value. Returns the parsed result
 * if the string starts with `opener` and parses successfully, otherwise null.
 */
function tryParseJsonString(value: string, opener: '{' | '['): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(opener)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Coerce array elements based on the `items` schema.
 * Also handles double-encoded arrays (LLM sends a JSON string instead of an array).
 */
function coerceArray(
  value: unknown,
  propSchema: Record<string, unknown>,
  mode: CoerceMode,
): unknown {
  let arr: unknown[];

  if (Array.isArray(value)) {
    arr = value;
  } else if (typeof value === 'string') {
    const parsed = tryParseJsonString(value, '[');
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else {
      return value;
    }
  } else {
    return value;
  }

  const itemsSchema = propSchema['items'];
  if (!itemsSchema || typeof itemsSchema !== 'object') {
    return arr;
  }

  return arr.map((item) =>
    coerceValue(item, itemsSchema as Record<string, unknown>, mode),
  );
}

/**
 * Coerce object properties based on nested `properties` / `additionalProperties`.
 * Also handles double-encoded objects (LLM sends a JSON string instead of an object).
 */
function coerceObject(
  value: unknown,
  propSchema: Record<string, unknown>,
  mode: CoerceMode,
): unknown {
  let obj: Record<string, unknown>;

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    obj = value as Record<string, unknown>;
  } else if (typeof value === 'string') {
    const parsed = tryParseJsonString(value, '{');
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      obj = parsed as Record<string, unknown>;
    } else {
      return value;
    }
  } else {
    return value;
  }

  const nestedProps = propSchema['properties'] as
    | Record<string, unknown>
    | undefined;
  const additionalSchema = propSchema['additionalProperties'] as
    | Record<string, unknown>
    | undefined;

  if (!nestedProps && !additionalSchema) {
    return obj;
  }

  let result = obj;
  if (nestedProps) {
    result = coerceArgsToSchemaInternal(obj, nestedProps, mode) as Record<
      string,
      unknown
    >;
  }

  if (additionalSchema) {
    for (const [key, val] of Object.entries(result)) {
      if (nestedProps && key in nestedProps) continue;
      result[key] = coerceValue(val, additionalSchema, mode);
    }
  }

  return result;
}
