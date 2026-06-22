/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import AjvPkg, { type AnySchema, type Ajv } from 'ajv';
// Ajv2020 is the documented way to use draft-2020-12: https://ajv.js.org/json-schema.html#draft-2020-12
// eslint-disable-next-line import/no-internal-modules
import Ajv2020Pkg from 'ajv/dist/2020.js';
import * as addFormats from 'ajv-formats';
import { createDebugLogger } from './debugLogger.js';

// Ajv's ESM/CJS interop: use 'any' for compatibility as recommended by Ajv docs
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvClass = (AjvPkg as any).default || AjvPkg;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv2020Class = (Ajv2020Pkg as any).default || Ajv2020Pkg;

const debugLogger = createDebugLogger('SchemaValidator');

const ajvOptions = {
  // See: https://ajv.js.org/options.html#strict-mode-options
  // strictSchema defaults to true and prevents use of JSON schemas that
  // include unrecognized keywords. The JSON schema spec specifically allows
  // for the use of non-standard keywords and the spec-compliant behavior
  // is to ignore those keywords. Note that setting this to false also
  // allows use of non-standard or custom formats (the unknown format value
  // will be logged but the schema will still be considered valid).
  strictSchema: false,
};

// Draft-07 validator (default)
const ajvDefault: Ajv = new AjvClass(ajvOptions);

// Draft-2020-12 validator for MCP servers using rmcp
const ajv2020: Ajv = new Ajv2020Class(ajvOptions);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormatsFunc = (addFormats as any).default || addFormats;
addFormatsFunc(ajvDefault);
addFormatsFunc(ajv2020);

// Canonical draft-2020-12 meta-schema URI (used by rmcp MCP servers).
// JSON Schema authors commonly include both `…/schema` and `…/schema#`
// — the trailing `#` is an empty fragment and points at the same
// document. Normalize before comparing so either form selects ajv2020.
const DRAFT_2020_12_SCHEMA = 'https://json-schema.org/draft/2020-12/schema';

function isDraft2020Uri(uri: unknown): boolean {
  if (typeof uri !== 'string') return false;
  const normalized = uri.endsWith('#') ? uri.slice(0, -1) : uri;
  return normalized === DRAFT_2020_12_SCHEMA;
}

/**
 * Returns the appropriate validator based on schema's $schema field.
 */
function getValidator(schema: AnySchema): Ajv {
  if (
    typeof schema === 'object' &&
    schema !== null &&
    '$schema' in schema &&
    isDraft2020Uri(schema.$schema)
  ) {
    return ajv2020;
  }
  return ajvDefault;
}

/**
 * Simple utility to validate objects against JSON Schemas.
 * Supports both draft-07 (default) and draft-2020-12 schemas.
 */
export class SchemaValidator {
  /**
   * Strictly compiles a schema. Returns an error message if the schema is
   * malformed or uses unsupported draft/features for our Ajv configuration
   * (see {@link getValidator} — `$schema` selects between draft-07 and
   * draft-2020-12; anything else falls through to draft-07's compiler).
   * Returns null on success. Unlike {@link validate}, this does NOT
   * silently skip on compile failure — callers (e.g. the CLI's
   * `--json-schema` parser) need to surface invalid schemas instead of
   * letting them no-op at runtime.
   */
  static compileStrict(schema: unknown): string | null {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return 'schema must be a JSON object';
    }
    // Use a dedicated Ajv with `strictSchema: true` so typos like
    // `propertees` raise instead of being silently ignored. The shared
    // ajvDefault/ajv2020 instances run with `strictSchema: false` so
    // unknown MCP keywords don't break runtime validation — that
    // leniency is wrong for explicit user-supplied schemas where
    // `compileStrict` is exactly the surface meant to surface mistakes.
    //
    // We deliberately do NOT pass `strict: true` (which would also
    // enable `strictRequired`, `strictTypes`, etc): those rules go
    // beyond JSON Schema validity and would reject spec-valid schemas
    // like `{type:'object', required:['x']}` (no matching `properties`)
    // or anything using a custom `format`. Keep typo detection;
    // tolerate the looser-but-still-spec-valid patterns users actually
    // ship in `--json-schema`.
    const strictOptions = {
      strictSchema: true, // catches unknown keywords (typos)
      strictRequired: false, // allow `required` without `properties`
      strictTypes: false, // allow inferred / partial type info
      validateFormats: false, // unknown `format` values don't fail
      allowUnionTypes: true, // type: ["a","b"]
    };
    const strictAjv: Ajv = isDraft2020Uri(
      (schema as { $schema?: unknown }).$schema,
    )
      ? new Ajv2020Class(strictOptions)
      : new AjvClass(strictOptions);
    addFormatsFunc(strictAjv);
    try {
      strictAjv.compile(schema as AnySchema);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Returns null if the data conforms to the schema described by schema (or if schema
   *  is null). Otherwise, returns a string describing the error.
   */
  static validate(schema: unknown | undefined, data: unknown): string | null {
    if (!schema) {
      return null;
    }
    if (typeof data !== 'object' || data === null) {
      return 'Value of params must be an object';
    }

    const anySchema = schema as AnySchema;
    const validator = getValidator(anySchema);

    // Try to compile and validate; skip validation if schema can't be compiled.
    // This handles schemas using JSON Schema versions AJV doesn't support
    // (e.g., draft-2019-09, future versions).
    // This matches LenientJsonSchemaValidator behavior in mcp-client.ts.
    let validate;
    try {
      validate = validator.compile(anySchema);
    } catch (error) {
      // Schema compilation failed (unsupported version, invalid $ref, etc.)
      // Skip validation rather than blocking tool usage.
      debugLogger.warn(
        `Failed to compile schema (${
          (schema as Record<string, unknown>)?.['$schema'] ?? '<no $schema>'
        }): ${error instanceof Error ? error.message : String(error)}. ` +
          'Skipping parameter validation.',
      );
      return null;
    }

    let valid = validate(data);
    if (!valid && validate.errors) {
      // --- Four-pass coercion ---
      //
      // The four passes run in a fixed order. Each pass targets a specific
      // class of model output error and is guarded by schema-aware skip logic
      // so it never coerces a value whose current type is already accepted.
      //
      // 1. fixBooleanValues  — "true"/"false" → true/false
      //    Runs first because string→boolean is the most common LLM error
      //    and is unambiguous: only triggers when schema accepts boolean.
      //
      // 2. fixStringValues   — number/boolean → string
      //    Runs second because it must see the post-pass-1 value. If pass 1
      //    coerced "true" → true and the schema accepts both boolean and
      //    string, pass 2 skips (boolean is already accepted). This prevents
      //    the boolean→string round-trip (Finding #5).
      //
      // 3. fixStringifiedJsonValues — '["a"]' → ["a"], '{"k":"v"}' → {k:"v"}
      //    Runs third; it only touches string values that look like JSON. By
      //    this point, plain strings are still strings (pass 2 only coerces
      //    non-strings), so pass 3 can safely parse without re-stringifying.
      //
      // 4. fixNumericValues  — "3"/"5.0" → 3/5.0
      //    Runs last. Only fires when the schema accepts integer/number and
      //    NOT string, which makes it mutually exclusive with pass 2 (pass 2
      //    requires string to be accepted). So it cannot round-trip pass 2's
      //    output, and it never sees pass 3's output (already an array/object,
      //    not a string).
      //
      // Invariant: passes 2–4 only coerce when the current type is NOT already
      // accepted. Pass 1 (boolean) coerces unconditionally when boolean is
      // accepted, because "true"/"false" strings are never intentional when
      // boolean is a valid type. The round-trip is prevented by pass 2 checking
      // typeIsAccepted before coercing.
      //
      // Adding a fifth pass or reordering requires verifying that the new pass
      // does not undo the work of earlier passes. See Finding #5 for a past
      // round-trip bug caused by violating this invariant.
      //
      // Coerce string boolean values ("true"/"false") to actual booleans
      fixBooleanValues(
        data as Record<string, unknown>,
        anySchema as Record<string, unknown>,
        anySchema as Record<string, unknown>,
      );
      // Coerce non-string values to strings where the schema expects strings.
      // Some self-hosted LLMs return numbers or booleans for tool parameters
      // that expect strings (e.g., `old_string`, `content`).
      fixStringValues(
        data as Record<string, unknown>,
        anySchema as Record<string, unknown>,
        anySchema as Record<string, unknown>,
      );
      // Coerce stringified JSON values (arrays/objects) back to their proper types.
      // Some LLMs serialize complex values as strings when the schema uses
      // anyOf/oneOf (e.g., '["url"]' instead of ["url"] for anyOf: [array, null]).
      fixStringifiedJsonValues(
        data as Record<string, unknown>,
        anySchema as Record<string, unknown>,
        anySchema as Record<string, unknown>,
      );
      // Coerce numeric strings ("3", "5.0") to actual numbers when the schema
      // expects integer/number. LLMs frequently emit numeric parameters as
      // strings which strict MCP servers (e.g. Playwright) reject.
      fixNumericValues(
        data as Record<string, unknown>,
        anySchema as Record<string, unknown>,
      );

      valid = validate(data);
      if (!valid && validate.errors) {
        return validator.errorsText(validate.errors, { dataVar: 'params' });
      }
    }
    return null;
  }
}

/**
 * Resolves a JSON Schema `$ref` pointer against a root schema.
 * Supports `#/definitions/X` and `#/$defs/X` fragment forms.
 * Returns null if the ref cannot be resolved.
 *
 * Guards against prototype pollution: only traverses own properties,
 * rejecting `__proto__`, `constructor`, `prototype`, and any non-own key.
 */
function resolveRef(
  ref: string,
  rootSchema: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = rootSchema;
  for (const rawPart of parts) {
    if (current == null || typeof current !== 'object') return null;
    // Decode RFC 6901 JSON Pointer escape sequences: ~1 → /, ~0 → ~
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    // Only traverse own properties — prevents __proto__/constructor/prototype
    // traversal that could resolve to Object.prototype or Function.prototype.
    if (!Object.hasOwn(current, part)) return null;
    current = current[part];
  }
  if (
    current != null &&
    typeof current === 'object' &&
    !Array.isArray(current)
  ) {
    return current as Record<string, unknown>;
  }
  return null;
}

/**
 * Resolves a property schema by following `$ref` if present.
 * Loops on `$ref` resolution to handle multi-hop chains (e.g.,
 * `$defs/A → $defs/B → $defs/C`). Returns the original schema if
 * no `$ref` or if resolution fails. Depth limit prevents infinite
 * loops from circular `$ref`.
 */
function resolvePropSchema(
  propSchema: Record<string, unknown> | undefined,
  rootSchema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!propSchema) return undefined;
  let schema = propSchema;
  let depth = 0;
  while (typeof schema['$ref'] === 'string' && depth < 64) {
    depth++;
    const resolved = resolveRef(schema['$ref'] as string, rootSchema);
    if (!resolved) return propSchema;
    schema = resolved;
  }
  return schema;
}

/**
 * Resolves the effective schema for an element at the given index within
 * an array, considering both `prefixItems` (draft-2020-12 tuple validation)
 * and `items` (uniform element schema).
 *
 * - If `prefixItems` is present and `index < prefixItems.length`, returns
 *   the resolved schema from `prefixItems[index]`.
 * - Otherwise, if `items` is present, returns the resolved `items` schema.
 * - If neither applies, returns `undefined` (no schema constraint for this
 *   position — coercion should skip this element).
 */
function resolveArrayElementSchema(
  parentSchema: Record<string, unknown>,
  rootSchema: Record<string, unknown>,
  index: number,
): Record<string, unknown> | undefined {
  const prefixItems = parentSchema['prefixItems'] as
    | Array<Record<string, unknown>>
    | undefined;
  if (prefixItems && index < prefixItems.length) {
    const entry = prefixItems[index];
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      return resolvePropSchema(entry, rootSchema);
    }
    return undefined;
  }
  const itemsSchema = parentSchema['items'] as
    | Record<string, unknown>
    | undefined;
  if (itemsSchema) {
    return resolvePropSchema(itemsSchema, rootSchema);
  }
  return undefined;
}

/**
 * Collects subschemas from composition keywords (allOf, anyOf, oneOf).
 * Used to find properties/additionalProperties/items buried inside
 * composition wrappers so coercion can recurse into nested objects.
 */
function getCompositionVariants(
  schema: Record<string, unknown>,
  rootSchema?: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const variants: Array<Record<string, unknown>> = [];
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    const val = schema[keyword];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'object' && item != null && !Array.isArray(item)) {
          // Resolve $ref on each variant so callers see the effective schema
          const resolved = rootSchema
            ? resolvePropSchema(item as Record<string, unknown>, rootSchema)
            : (item as Record<string, unknown>);
          if (resolved) variants.push(resolved);
        }
      }
    }
  }
  return variants;
}

/**
 * Checks if a schema (or any of its composition keyword variants) has
 * `properties` or `additionalProperties`, indicating it defines an
 * object type that coercion should recurse into.
 */
function schemaHasObjectShape(
  schema: Record<string, unknown>,
  rootSchema?: Record<string, unknown>,
): boolean {
  if (schema['properties'] || schema['additionalProperties']) return true;
  for (const variant of getCompositionVariants(schema, rootSchema)) {
    if (variant['properties'] || variant['additionalProperties']) return true;
  }
  return false;
}

/**
 * Collects property schemas from both top-level `properties` and from
 * composition keyword variants (allOf/anyOf/oneOf). Returns a merged
 * map so coercion can look up schemas for keys defined at any level.
 */
// Keys that, if assigned via bracket notation, would pollute the prototype
// chain of a plain object. A malicious MCP schema may include any of these
// as own keys in `properties` (e.g., via JSON.parse), and `merged[k] = v`
// would trigger the inherited setter, replacing the prototype.
const DANGEROUS_PROP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function getEffectiveProperties(
  schema: Record<string, unknown>,
  rootSchema?: Record<string, unknown>,
): Record<string, Record<string, unknown>> | undefined {
  // Use a null-prototype object so even a successful `__proto__` assignment
  // cannot mutate the prototype chain. `Object.create(null)` returns a plain
  // object with no inherited members, eliminating the attack surface.
  const merged: Record<string, Record<string, unknown>> = Object.create(null);
  // Properties from composition variants (resolved $ref); filled first
  // so top-level properties can override on collision.
  for (const variant of getCompositionVariants(schema, rootSchema)) {
    const variantProps = variant['properties'] as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (variantProps) {
      for (const [k, v] of Object.entries(variantProps)) {
        if (DANGEROUS_PROP_KEYS.has(k)) continue;
        if (!Object.hasOwn(merged, k)) merged[k] = v;
      }
    }
  }
  // Top-level properties overwrite on collision (more specific)
  const topProps = schema['properties'] as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (topProps) {
    for (const [k, v] of Object.entries(topProps)) {
      if (DANGEROUS_PROP_KEYS.has(k)) continue;
      merged[k] = v;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Returns the set of JSON Schema types that a property accepts,
 * considering `type`, `anyOf`, `oneOf`, `allOf`, and `$ref` keywords.
 * Recurses into nested composition keywords to resolve types.
 *
 * Note: `allOf` is treated as a type union (same as `anyOf`/`oneOf`)
 * rather than intersection. This is semantically imprecise but safe —
 * the bias is toward under-coercion (leaving values unchanged), and
 * re-validation via Ajv catches any incorrect results.
 *
 * Depth limit prevents stack overflow from circular `$ref` or deeply
 * nested composition keywords (e.g., 10,000 levels of `anyOf`).
 *
 * Memoization: results are cached by resolved-schema object identity within a
 * single recursive descent. A compact schema can describe an exponentially
 * branching type tree through `$ref` — e.g. `$defs/Dn → anyOf: [{$ref:Dn-1},
 * {$ref:Dn-1}]`. Without memoization each shared `$defs/Dk` target is
 * re-traversed once per path that reaches it, giving O(2^depth) calls (measured
 * ~9s at depth 24). Because every `{$ref:Dk}` literal resolves to the *same*
 * `Dk` object, keying the cache on the resolved object (not the input) lets all
 * those paths share one computation, collapsing the descent to O(depth). The
 * cache is created fresh per top-level entry (default param), so it never grows
 * unbounded or leaks across `validate()` calls.
 */
function getAcceptedTypes(
  propSchema: Record<string, unknown>,
  rootSchema?: Record<string, unknown>,
  depth = 0,
  // Keyed by the *resolved* schema object. Default-evaluated per top-level call
  // (callers omit it), so memoization is scoped to a single recursive descent.
  cache: WeakMap<Record<string, unknown>, Set<string> | null> = new WeakMap(),
): Set<string> | null {
  // Guard against stack overflow from circular $ref or deeply nested
  // composition keywords. 64 levels is far more than any real schema needs.
  if (depth > 64) return null;

  let schema = propSchema;

  // Resolve $ref chain using resolvePropSchema (handles multi-hop chains
  // like $defs/A → $defs/B → $defs/C → {type: 'string'}).
  if (typeof schema['$ref'] === 'string' && rootSchema) {
    const resolved = resolvePropSchema(propSchema, rootSchema);
    if (!resolved || typeof resolved['$ref'] === 'string') {
      // Unresolvable or partially-resolved $ref chain — skip coercion
      return null;
    }
    schema = resolved;
  }

  // Memoize on the resolved object. Only objects are valid WeakMap keys, so
  // boolean / primitive schemas (e.g. JSON Schema `items: true`) bypass the
  // cache — they are leaf schemas with no composition recursion to memoize.
  // A cache miss returns `undefined`; a cached `null` (schema accepts no typed
  // value) returns `null`, so the `!== undefined` check keeps both distinct.
  const cacheable = typeof schema === 'object' && schema !== null;
  if (cacheable) {
    const cached = cache.get(schema);
    if (cached !== undefined) return cached;
  }

  const types = new Set<string>();

  if (typeof schema === 'object' && schema !== null) {
    if (typeof schema['type'] === 'string') {
      types.add(schema['type'] as string);
    } else if (Array.isArray(schema['type'])) {
      for (const t of schema['type'] as string[]) {
        types.add(t);
      }
    }

    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
      const variants = schema[keyword];
      if (Array.isArray(variants)) {
        for (const variant of variants as Array<Record<string, unknown>>) {
          const nested = getAcceptedTypes(
            variant,
            rootSchema,
            depth + 1,
            cache,
          );
          if (nested) {
            for (const t of nested) {
              types.add(t);
            }
          }
        }
      }
    }
  }

  const result = types.size > 0 ? types : null;
  if (cacheable) cache.set(schema, result);
  return result;
}

/**
 * Maps a JavaScript value to its closest JSON Schema type name.
 * Used to check whether a value already satisfies the schema before coercing.
 */
function valueToSchemaType(value: unknown): string | null {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'bigint') return 'integer';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null; // NaN/Infinity — don't coerce
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return null;
}

/**
 * Checks whether a JSON Schema type is accepted by the given set.
 * Handles the integer/number subtype relationship: in JSON Schema,
 * `integer` is a subtype of `number`, so a value of type `integer`
 * is valid when the schema accepts `number`.
 */
function typeIsAccepted(valueType: string, accepted: Set<string>): boolean {
  if (accepted.has(valueType)) return true;
  // integer is a subtype of number
  if (valueType === 'integer' && accepted.has('number')) return true;
  return false;
}

/**
 * Coerces stringified JSON elements in a primitive array.
 * Used as a helper for arrays of arrays (e.g., `[[1], ["[2]"]]`).
 *
 * `key` is the owning object property name, used only for debug-log context so
 * coercions inside nested arrays are visible alongside the sibling functions.
 */
function fixStringifiedJsonValuesInArray(
  array: unknown[],
  itemsSchema: Record<string, unknown>,
  root: Record<string, unknown>,
  key: string,
) {
  // Tuple validation: per-element schema resolution
  if (Array.isArray(itemsSchema['prefixItems'])) {
    for (let i = 0; i < array.length; i++) {
      const elSchema = resolveArrayElementSchema(itemsSchema, root, i);
      if (!elSchema) continue;
      const item = array[i];
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (
        (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        (trimmed.startsWith('{') && trimmed.endsWith('}'))
      ) {
        const elAccepted = getAcceptedTypes(elSchema, root);
        if (elAccepted && !elAccepted.has('string')) {
          try {
            const parsed = JSON.parse(trimmed);
            const parsedType = Array.isArray(parsed) ? 'array' : typeof parsed;
            if (elAccepted.has(parsedType)) {
              debugLogger.debug(
                `coercion: ${key}[${i}] = ${String(item)} → ${JSON.stringify(parsed)} (accepted: ${[...elAccepted].join('|')})`,
              );
              array[i] = parsed;
            }
          } catch {
            // Not valid JSON — leave unchanged
          }
        }
      }
    }
    return;
  }

  // Uniform items schema — callers pass the array-level schema for each
  // sub-array element (e.g. {type: "array", items: {type: "object"}}).
  // getAcceptedTypes on that outer schema would return {array} and never
  // match parsed objects/primitives. Drill into .items to reach the
  // element-level schema first.
  const resolvedItems = resolvePropSchema(itemsSchema, root);
  if (!resolvedItems) return;
  const innerItems = resolvedItems['items'] as
    | Record<string, unknown>
    | undefined;
  const resolvedInner = innerItems
    ? resolvePropSchema(innerItems, root)
    : undefined;
  const itemsAccepted = resolvedInner
    ? getAcceptedTypes(resolvedInner, root)
    : null;
  if (!itemsAccepted || itemsAccepted.has('string')) return;

  for (let i = 0; i < array.length; i++) {
    const item = array[i];
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        const parsedType = Array.isArray(parsed) ? 'array' : typeof parsed;
        if (itemsAccepted.has(parsedType)) {
          debugLogger.debug(
            `coercion: ${key}[${i}] = ${String(item)} → ${JSON.stringify(parsed)} (accepted: ${[...itemsAccepted].join('|')})`,
          );
          array[i] = parsed;
        }
      } catch {
        // Not valid JSON — leave unchanged
      }
    }
  }
}

/**
 * Coerces stringified JSON values back to their proper types.
 * Some LLMs serialize arrays/objects as JSON strings when the schema uses
 * anyOf/oneOf with mixed types (e.g., `list[str] | None` in Python becomes
 * `anyOf: [{type: "array"}, {type: "null"}]`). The model may return
 * '["url"]' (a string) instead of ["url"] (an actual array).
 *
 * This function parses such strings back to their intended type when:
 * 1. The value is a string starting with `[` or `{`
 * 2. The schema accepts array or object but not string
 * 3. The parsed result matches one of the accepted types
 *
 * Recurses into nested objects so that deeply nested stringified values
 * are also repaired.
 */
function fixStringifiedJsonValues(
  data: Record<string, unknown>,
  schema: Record<string, unknown>,
  rootSchema?: Record<string, unknown>,
  depth = 0,
) {
  // Guard against stack overflow from deeply nested data (e.g. recursive
  // additionalProperties schemas with matching deep data from LLMs).
  if (depth > 64) return;
  const root = rootSchema ?? schema;
  const properties = getEffectiveProperties(schema, root);
  if (!properties && !schema['additionalProperties']) return;

  for (const key of Object.keys(data)) {
    const value = data[key];
    const additionalProps = schema['additionalProperties'];
    const propSchema =
      properties?.[key] ??
      (typeof additionalProps === 'object' && additionalProps !== null
        ? (additionalProps as Record<string, unknown>)
        : undefined);
    if (!propSchema) continue;

    // Resolve $ref so we get the effective schema for recursion decisions.
    const resolved = resolvePropSchema(
      propSchema as Record<string, unknown>,
      root,
    );
    if (!resolved) continue;

    // Recurse into nested objects
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      if (schemaHasObjectShape(resolved, root)) {
        fixStringifiedJsonValues(
          value as Record<string, unknown>,
          resolved,
          root,
          depth + 1,
        );
      }
      continue;
    }

    // Recurse into arrays
    if (Array.isArray(value)) {
      if (Array.isArray(resolved['prefixItems'])) {
        // Tuple validation (prefixItems): per-element schema resolution
        for (let i = 0; i < value.length; i++) {
          const elSchema = resolveArrayElementSchema(resolved, root, i);
          if (!elSchema) continue;
          const item = value[i];

          if (
            typeof item === 'object' &&
            item !== null &&
            !Array.isArray(item)
          ) {
            if (schemaHasObjectShape(elSchema, root)) {
              fixStringifiedJsonValues(
                item as Record<string, unknown>,
                elSchema,
                root,
                depth + 1,
              );
            }
          } else if (Array.isArray(item)) {
            if (
              elSchema['type'] === 'array' ||
              elSchema['items'] ||
              elSchema['prefixItems']
            ) {
              fixStringifiedJsonValuesInArray(item, elSchema, root, key);
            }
          } else if (typeof item === 'string') {
            const elAccepted = getAcceptedTypes(elSchema, root);
            if (elAccepted && !elAccepted.has('string')) {
              const trimmed = item.trim();
              if (
                (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
                (trimmed.startsWith('{') && trimmed.endsWith('}'))
              ) {
                try {
                  const parsed = JSON.parse(trimmed);
                  const parsedType = Array.isArray(parsed)
                    ? 'array'
                    : typeof parsed;
                  if (elAccepted.has(parsedType)) {
                    debugLogger.debug(
                      `coercion: ${key}[${i}] = ${String(item)} → ${JSON.stringify(parsed)} (accepted: ${[...elAccepted].join('|')})`,
                    );
                    value[i] = parsed;
                  }
                } catch {
                  // Not valid JSON — leave unchanged
                }
              }
            }
          }
        }
      } else {
        // Uniform items schema
        const itemsSchema = resolved['items'] as
          | Record<string, unknown>
          | undefined;
        if (itemsSchema) {
          // Resolve $ref on items schema too
          const resolvedItems = resolvePropSchema(itemsSchema, root);
          if (!resolvedItems) continue;
          if (schemaHasObjectShape(resolvedItems, root)) {
            // Array of objects — recurse into each item; also attempt
            // JSON.parse on string elements that look like stringified objects
            // (matches the prefixItems branch behaviour).
            const itemsAccepted = getAcceptedTypes(resolvedItems, root);
            for (let i = 0; i < value.length; i++) {
              const item = value[i];
              if (
                typeof item === 'object' &&
                item !== null &&
                !Array.isArray(item)
              ) {
                fixStringifiedJsonValues(
                  item as Record<string, unknown>,
                  resolvedItems,
                  root,
                  depth + 1,
                );
              } else if (
                typeof item === 'string' &&
                itemsAccepted &&
                !itemsAccepted.has('string')
              ) {
                const trimmed = item.trim();
                if (
                  (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
                  (trimmed.startsWith('[') && trimmed.endsWith(']'))
                ) {
                  try {
                    const parsed = JSON.parse(trimmed);
                    if (
                      itemsAccepted.has(
                        Array.isArray(parsed) ? 'array' : typeof parsed,
                      )
                    ) {
                      debugLogger.debug(
                        `coercion: ${key}[${i}] = ${String(item)} → ${JSON.stringify(parsed)} (accepted: ${[...itemsAccepted].join('|')})`,
                      );
                      value[i] = parsed;
                    }
                  } catch {
                    // Not valid JSON — leave unchanged
                  }
                }
              }
            }
          } else if (
            resolvedItems['type'] === 'array' ||
            resolvedItems['items'] ||
            resolvedItems['prefixItems']
          ) {
            // Array of arrays — recurse into each sub-array
            for (const subArray of value) {
              if (Array.isArray(subArray)) {
                fixStringifiedJsonValuesInArray(
                  subArray,
                  resolvedItems,
                  root,
                  key,
                );
              }
            }
          } else {
            // Array of primitives — try to parse stringified JSON elements
            const itemsAccepted = getAcceptedTypes(resolvedItems, root);
            if (itemsAccepted && !itemsAccepted.has('string')) {
              for (let i = 0; i < value.length; i++) {
                const item = value[i];
                if (typeof item !== 'string') continue;
                const trimmed = item.trim();
                if (
                  (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
                  (trimmed.startsWith('{') && trimmed.endsWith('}'))
                ) {
                  try {
                    const parsed = JSON.parse(trimmed);
                    const parsedType = Array.isArray(parsed)
                      ? 'array'
                      : typeof parsed;
                    if (itemsAccepted.has(parsedType)) {
                      debugLogger.debug(
                        `coercion: ${key}[${i}] = ${String(item)} → ${JSON.stringify(parsed)} (accepted: ${[...itemsAccepted].join('|')})`,
                      );
                      value[i] = parsed;
                    }
                  } catch {
                    // Not valid JSON — leave unchanged
                  }
                }
              }
            }
          }
        }
      }
      continue;
    }

    if (typeof value !== 'string') continue;

    const trimmed = value.trim();
    if (
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
    ) {
      const accepted = getAcceptedTypes(resolved, root);
      if (!accepted) continue;
      // Only coerce if the schema does NOT accept string — otherwise the
      // string value may be intentional.
      if (accepted.has('string')) continue;
      if (!accepted.has('array') && !accepted.has('object')) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed);
        const parsedType = Array.isArray(parsed) ? 'array' : typeof parsed;
        if (accepted.has(parsedType)) {
          debugLogger.debug(
            `coercion: ${key} = ${String(value)} → ${JSON.stringify(parsed)} (accepted: ${[...accepted].join('|')})`,
          );
          data[key] = parsed;
        }
      } catch {
        // Not valid JSON — leave the value unchanged
      }
    }
  }
}

/**
 * Coerces string numeric values to actual numbers.
 * LLMs frequently emit numeric parameters as strings (e.g. `{"depth": "3"}`)
 * which strict MCP servers (e.g. Playwright) reject with schema validation
 * errors like "params/depth must be number".
 *
 * Only coerces when:
 * 1. The value is a string that looks like a clean number
 * 2. The schema accepts integer/number but NOT string
 */
function fixNumericValues(
  data: Record<string, unknown>,
  schema: Record<string, unknown>,
) {
  const properties = schema['properties'] as
    | Record<string, Record<string, unknown>>
    | undefined;
  const items = schema['items'] as Record<string, unknown> | undefined;

  for (const key of Object.keys(data)) {
    if (!(key in data)) continue;
    const value = data[key];
    const childSchema = Array.isArray(data) ? items : properties?.[key];

    if (typeof value === 'object' && value !== null) {
      fixNumericValues(value as Record<string, unknown>, childSchema ?? {});
      continue;
    }

    if (typeof value !== 'string') continue;

    const accepted = childSchema ? getAcceptedTypes(childSchema) : null;
    if (!accepted || accepted.has('string')) continue;
    const wantsInteger = accepted.has('integer');
    const wantsNumber = accepted.has('number');
    if (!wantsInteger && !wantsNumber) continue;

    const trimmed = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) continue;

    const num = parseFloat(trimmed);
    // Reject non-integer values (e.g. "5.5") for integer-only schemas so the
    // LLM self-corrects. Whole-number decimals (e.g. "3.0") still coerce.
    if (wantsInteger && !wantsNumber && num % 1 !== 0) continue;

    const parsed = wantsNumber ? num : parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) {
      data[key] = parsed;
    }
  }
}

/**
 * Coerces string boolean values ("true"/"false") to actual booleans.
 * This handles cases where LLMs return "true"/"false" strings instead of boolean values,
 * which is common with self-hosted LLMs.
 *
 * Only coerces when the schema explicitly accepts boolean type (via `type`, `anyOf`,
 * `oneOf`, or `allOf`). Schemas without type info (enum-only, const-only) are left
 * untouched to avoid corrupting legitimate string values.
 *
 * Handles nested objects and arrays by recursing with the appropriate sub-schema.
 * Does NOT recurse blindly into objects whose schema lacks `properties` — this
 * prevents unconditional coercion on fields with unknown types.
 */
function fixBooleanValues(
  data: Record<string, unknown>,
  schema: Record<string, unknown>,
  rootSchema?: Record<string, unknown>,
  depth = 0,
) {
  // Guard against stack overflow from deeply nested data.
  if (depth > 64) return;
  const root = rootSchema ?? schema;
  const properties = getEffectiveProperties(schema, root);
  if (!properties && !schema['additionalProperties']) return;

  for (const key of Object.keys(data)) {
    const value = data[key];
    const additionalProps = schema['additionalProperties'];
    const propSchema =
      properties?.[key] ??
      (typeof additionalProps === 'object' && additionalProps !== null
        ? (additionalProps as Record<string, unknown>)
        : undefined);

    // Resolve $ref so we get the effective schema for recursion decisions.
    const resolved = propSchema
      ? resolvePropSchema(propSchema as Record<string, unknown>, root)
      : undefined;

    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        if (Array.isArray(resolved?.['prefixItems'])) {
          // Tuple validation (prefixItems): per-element schema resolution
          for (let i = 0; i < value.length; i++) {
            const elSchema = resolveArrayElementSchema(resolved!, root, i);
            if (!elSchema) continue;
            const item = value[i];

            if (
              typeof item === 'object' &&
              item !== null &&
              !Array.isArray(item)
            ) {
              if (schemaHasObjectShape(elSchema, root)) {
                fixBooleanValues(
                  item as Record<string, unknown>,
                  elSchema,
                  root,
                  depth + 1,
                );
              }
            } else if (typeof item === 'string') {
              const elAccepted = getAcceptedTypes(elSchema, root);
              // Same string-guard as the scalar path: don't coerce a
              // legitimate string when the element also accepts string.
              if (elAccepted?.has('boolean') && !elAccepted.has('string')) {
                const lower = item.toLowerCase();
                if (lower === 'true' || lower === 'false') {
                  debugLogger.debug(
                    `coercion: ${key}[${i}] = ${JSON.stringify(item)} → ${lower === 'true'} (accepted: ${[...elAccepted].join('|')})`,
                  );
                  value[i] = lower === 'true';
                }
              }
            }
          }
        } else {
          // Uniform items schema
          const itemsSchema = resolved?.['items'] as
            | Record<string, unknown>
            | undefined;
          if (itemsSchema) {
            // Resolve $ref on items schema too
            const resolvedItems = resolvePropSchema(itemsSchema, root);
            if (!resolvedItems) continue;
            if (schemaHasObjectShape(resolvedItems, root)) {
              // Array of objects — recurse into each item
              for (const item of value) {
                if (
                  typeof item === 'object' &&
                  item !== null &&
                  !Array.isArray(item)
                ) {
                  fixBooleanValues(
                    item as Record<string, unknown>,
                    resolvedItems,
                    root,
                    depth + 1,
                  );
                }
              }
            } else {
              // Array of primitives — coerce "true"/"false" strings when
              // the items schema accepts boolean (and not also string).
              const itemsAccepted = getAcceptedTypes(resolvedItems, root);
              if (
                itemsAccepted?.has('boolean') &&
                !itemsAccepted.has('string')
              ) {
                for (let i = 0; i < value.length; i++) {
                  const item = value[i];
                  if (typeof item === 'string') {
                    const lower = item.toLowerCase();
                    if (lower === 'true' || lower === 'false') {
                      debugLogger.debug(
                        `coercion: ${key}[${i}] = ${JSON.stringify(item)} → ${lower === 'true'} (accepted: ${[...itemsAccepted].join('|')})`,
                      );
                      value[i] = lower === 'true';
                    }
                  }
                }
              }
            }
          }
        }
      } else {
        // Recurse into nested objects only when we have a sub-schema with
        // properties or additionalProperties (including via composition
        // keywords). Do NOT recurse blindly — avoids corrupting string
        // values in objects whose schema doesn't define property types.
        if (resolved && schemaHasObjectShape(resolved, root)) {
          fixBooleanValues(
            value as Record<string, unknown>,
            resolved,
            root,
            depth + 1,
          );
        }
      }
      continue;
    }

    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower !== 'true' && lower !== 'false') continue;

      // Only coerce when the schema explicitly accepts boolean AND does NOT
      // also accept string. If getAcceptedTypes returns null (no type info —
      // enum-only, const-only, or empty schemas), or if string is also
      // accepted, skip: the value is a legitimate string ("true"/"false" as
      // text, e.g. an old_string argument) and coercing it to a boolean would
      // corrupt the tool call. Mirrors fixStringValues / fixStringifiedJsonValues
      // and main's pre-existing guard.
      const accepted = resolved ? getAcceptedTypes(resolved, root) : null;
      if (accepted?.has('boolean') && !accepted.has('string')) {
        debugLogger.debug(
          `coercion: ${key} = ${JSON.stringify(value)} → ${lower === 'true'} (accepted: ${[...accepted].join('|')})`,
        );
        data[key] = lower === 'true';
      }
    }
  }
}

/**
 * Coerces non-string values to strings where the schema expects a string type.
 * This handles cases where LLMs return numbers or booleans instead of string values
 * for tool parameters like `old_string`, `content`, etc.
 * Common with self-hosted LLMs (e.g., via LMStudio, sglang, vllm).
 *
 * Only coerces scalar types (number, boolean, bigint) — objects and arrays are
 * left alone to avoid coercing `{ x: 1 }` to `"[object Object]"`.
 *
 * Avoids unnecessary coercion: if the value's current type is already accepted
 * by the schema (e.g., an integer in `anyOf: [integer, string]`), the value is
 * left unchanged.
 *
 * Handles nested objects, arrays of objects (via items.properties), and arrays
 * of primitives (via items.type).
 */
function fixStringValues(
  data: Record<string, unknown>,
  schema: Record<string, unknown>,
  rootSchema?: Record<string, unknown>,
  depth = 0,
) {
  // Guard against stack overflow from deeply nested data.
  if (depth > 64) return;
  const root = rootSchema ?? schema;
  const properties = getEffectiveProperties(schema, root);
  if (!properties && !schema['additionalProperties']) return;

  for (const key of Object.keys(data)) {
    const value = data[key];
    const additionalProps = schema['additionalProperties'];
    const propSchema =
      properties?.[key] ??
      (typeof additionalProps === 'object' && additionalProps !== null
        ? (additionalProps as Record<string, unknown>)
        : undefined);
    if (!propSchema) continue;

    // Resolve $ref so we get the effective schema for recursion decisions.
    const resolved = resolvePropSchema(
      propSchema as Record<string, unknown>,
      root,
    );
    if (!resolved) continue;

    // Recurse into nested values
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        if (Array.isArray(resolved['prefixItems'])) {
          // Tuple validation (prefixItems): per-element schema resolution
          let coerced: unknown[] | undefined;
          for (let i = 0; i < value.length; i++) {
            const elSchema = resolveArrayElementSchema(resolved, root, i);
            if (!elSchema) continue;
            const item = value[i];

            if (
              typeof item === 'object' &&
              item !== null &&
              !Array.isArray(item)
            ) {
              if (schemaHasObjectShape(elSchema, root)) {
                fixStringValues(
                  item as Record<string, unknown>,
                  elSchema,
                  root,
                  depth + 1,
                );
              }
            } else if (
              item !== null &&
              item !== undefined &&
              (typeof item === 'number' ||
                typeof item === 'boolean' ||
                typeof item === 'bigint')
            ) {
              const elAccepted = getAcceptedTypes(elSchema, root);
              if (elAccepted?.has('string')) {
                const currentType = valueToSchemaType(item);
                if (currentType && !typeIsAccepted(currentType, elAccepted)) {
                  coerced ??= [...value];
                  debugLogger.debug(
                    `coercion: ${key}[${i}] = ${String(item)} → ${JSON.stringify(String(item))} (accepted: ${[...elAccepted].join('|')})`,
                  );
                  coerced[i] = String(item);
                }
              }
            }
          }
          if (coerced) data[key] = coerced;
        } else {
          // Uniform items schema
          const itemsSchema = resolved['items'] as
            | Record<string, unknown>
            | undefined;
          if (itemsSchema) {
            // Resolve $ref on items schema too
            const resolvedItems = resolvePropSchema(itemsSchema, root);
            if (resolvedItems) {
              if (schemaHasObjectShape(resolvedItems, root)) {
                // Array of objects with defined properties — recurse into each item
                for (const item of value) {
                  if (
                    typeof item === 'object' &&
                    item !== null &&
                    !Array.isArray(item)
                  ) {
                    fixStringValues(
                      item as Record<string, unknown>,
                      resolvedItems,
                      root,
                      depth + 1,
                    );
                  }
                }
              } else {
                // Array of primitives — coerce each element if items schema
                // accepts string and the element's current type is not accepted.
                const itemsAccepted = getAcceptedTypes(resolvedItems, root);
                if (itemsAccepted?.has('string')) {
                  let coerced: unknown[] | undefined;
                  for (let i = 0; i < value.length; i++) {
                    const item = value[i];
                    if (
                      item !== null &&
                      item !== undefined &&
                      (typeof item === 'number' ||
                        typeof item === 'boolean' ||
                        typeof item === 'bigint')
                    ) {
                      const currentType = valueToSchemaType(item);
                      if (
                        currentType &&
                        !typeIsAccepted(currentType, itemsAccepted)
                      ) {
                        coerced ??= [...value];
                        debugLogger.debug(
                          `coercion: ${key}[${i}] = ${String(item)} → ${JSON.stringify(String(item))} (accepted: ${[...itemsAccepted].join('|')})`,
                        );
                        coerced[i] = String(item);
                      }
                    }
                  }
                  if (coerced) data[key] = coerced;
                }
              }
            }
          }
        }
      } else {
        // Recurse into nested objects when sub-schema has properties or
        // additionalProperties (including via composition keywords).
        if (schemaHasObjectShape(resolved, root)) {
          fixStringValues(
            value as Record<string, unknown>,
            resolved,
            root,
            depth + 1,
          );
        }
      }
      continue;
    }

    // Only coerce scalar types that are plausibly model formatting mistakes.
    // Objects and arrays would stringify to "[object Object]" or similar,
    // which is almost never the intent.
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      const accepted = getAcceptedTypes(resolved, root);
      if (accepted?.has('string')) {
        // Don't coerce if the value's current type is already accepted
        // (e.g., integer 42 in anyOf: [integer, string]).
        const currentType = valueToSchemaType(value);
        if (currentType && !typeIsAccepted(currentType, accepted)) {
          debugLogger.debug(
            `coercion: ${key} = ${String(value)} → ${JSON.stringify(String(value))} (accepted: ${[...accepted].join('|')})`,
          );
          data[key] = String(value);
        }
      }
    }
  }
}
