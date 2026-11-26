/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import AjvPkg, { type AnySchema, type Ajv, type ErrorObject } from 'ajv';
// Ajv2020 is the documented way to use draft-2020-12: https://ajv.js.org/json-schema.html#draft-2020-12

import Ajv2020Pkg from 'ajv/dist/2020.js';
import * as addFormats from 'ajv-formats';
import { runLogger } from './runLogger.js';

// Ajv's ESM/CJS interop: use 'any' for compatibility as recommended by Ajv docs
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvClass = (AjvPkg as any).default || AjvPkg;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv2020Class = (Ajv2020Pkg as any).default || Ajv2020Pkg;

const ajvOptions = {
  // See: https://ajv.js.org/options.html#strict-mode-options
  // strictSchema defaults to true and prevents use of JSON schemas that
  // include unrecognized keywords. The JSON schema spec specifically allows
  // for the use of non-standard keywords and the spec-compliant behavior
  // is to ignore those keywords. Note that setting this to false also
  // allows use of non-standard or custom formats (the unknown format value
  // will be logged but the schema will still be considered valid).
  strictSchema: false,
  // LLMs often return number/boolean values as strings (e.g., offset: "10"
  // instead of offset: 10). coerceTypes tells AJV to automatically convert
  // compatible string values to the type declared in the schema, avoiding
  // spurious validation failures like "params/offset must be number".
  coerceTypes: true,
};

// Draft-07 validator (default)
const ajvDefault: Ajv = new AjvClass(ajvOptions);

// Draft-2020-12 validator for MCP servers using rmcp
const ajv2020: Ajv = new Ajv2020Class(ajvOptions);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormatsFunc = (addFormats as any).default || addFormats;
addFormatsFunc(ajvDefault);
addFormatsFunc(ajv2020);

// Canonical draft-2020-12 meta-schema URI (used by rmcp MCP servers)
const DRAFT_2020_12_SCHEMA = 'https://json-schema.org/draft/2020-12/schema';

export type SchemaValidationMode = 'coerce' | 'coerce-on-failure';

// Create the extra validators only when an MCP tool needs them. Each instance
// retains AJV's compiled-schema cache, just like the coercing validators.
const nonCoercingValidators = new Map<Ajv, Ajv>();

function getNonCoercingValidator(validator: Ajv): Ajv {
  let nonCoercing = nonCoercingValidators.get(validator);
  if (!nonCoercing) {
    const ValidatorClass = validator === ajv2020 ? Ajv2020Class : AjvClass;
    nonCoercing = new ValidatorClass({
      ...ajvOptions,
      coerceTypes: false,
    }) as Ajv;
    addFormatsFunc(nonCoercing);
    nonCoercingValidators.set(validator, nonCoercing);
  }
  return nonCoercing;
}

/**
 * Returns the appropriate validator based on schema's $schema field.
 */
function getValidator(schema: AnySchema): Ajv {
  if (
    typeof schema === 'object' &&
    schema !== null &&
    '$schema' in schema &&
    schema.$schema === DRAFT_2020_12_SCHEMA
  ) {
    return ajv2020;
  }
  return ajvDefault;
}

// AJV's default text omits the offending field for additionalProperties.
// Include its name so callers can correct the input; keep raw diagnostics intact.
function errorsText(
  validator: Ajv,
  errors: readonly ErrorObject[],
  data: unknown,
  dataVar?: string,
): string {
  return errors
    .map((error) => {
      if (error.keyword !== 'additionalProperties')
        return validator.errorsText([error], { dataVar });

      // Decode AJV's JSON pointer, retaining array indices and object keys.
      const segments = error.instancePath
        .split('/')
        .slice(1)
        .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
      segments.push(error.params['additionalProperty']);
      let parent = data;
      let path = '';
      for (const [index, segment] of segments.entries()) {
        path += Array.isArray(parent)
          ? `[${segment}]`
          : `${index === 0 ? '' : '.'}${segment}`;
        parent =
          typeof parent === 'object' && parent !== null
            ? (parent as Record<string, unknown>)[segment]
            : undefined;
      }
      return `An unexpected parameter \`${path}\` was provided`;
    })
    .join(', ');
}

/**
 * Simple utility to validate objects against JSON Schemas.
 * Supports both draft-07 (default) and draft-2020-12 schemas.
 */
export class SchemaValidator {
  /** Output contracts must neither coerce values nor ignore invalid schemas. */
  static validateStrict(schema: AnySchema, data: unknown): string | null {
    const validator = getNonCoercingValidator(getValidator(schema));
    const validate = validator.compile(schema);
    return validate(data) ? null : errorsText(validator, validate.errors!, data);
  }
  /**
   * Returns null if the data conforms to the schema described by schema (or if schema
   *  is null). Otherwise, returns a string describing the error.
   */
  static validate(
    schema: unknown | undefined,
    data: unknown,
    mode: SchemaValidationMode = 'coerce',
  ): string | null {
    return this.validateWithDetails(schema, data, mode)?.message ?? null;
  }

  static validateWithDetails(
    schema: unknown | undefined,
    data: unknown,
    mode: SchemaValidationMode = 'coerce',
  ): { message: string; errors: readonly ErrorObject[] } | null {
    if (!schema) {
      return null;
    }
    if (typeof data !== 'object' || data === null) {
      return { message: 'Value of params must be an object', errors: [] };
    }

    const anySchema = schema as AnySchema;
    const validator = getValidator(anySchema);

    // Try to compile and validate; skip validation if schema can't be compiled.
    // This handles schemas using JSON Schema versions AJV doesn't support
    // (e.g., draft-2019-09, future versions).
    // This matches LenientJsonSchemaValidator behavior in mcp-client.ts.
    let validate;
    try {
      // Already-valid unions (notably oneOf string/number) must not be
      // coerced into matching multiple branches. Only report the final result.
      if (
        mode === 'coerce-on-failure' &&
        getNonCoercingValidator(validator).compile(anySchema)(data)
      ) {
        return null;
      }
      validate = validator.compile(anySchema);
    } catch (error) {
      // Schema compilation failed (unsupported version, invalid $ref, etc.)
      // Skip validation rather than blocking tool usage.
      // This matches LenientJsonSchemaValidator behavior in mcp-client.ts.
      runLogger.warn(
        `Failed to compile schema (${
          (schema as Record<string, unknown>)?.['$schema'] ?? '<no $schema>'
        }): ${error instanceof Error ? error.message : String(error)}. ` +
          'Skipping parameter validation.',
      );
      return null;
    }

    // Failed coercion can still mutate data. Keep the original input available
    // for error diagnostics, and commit corrections only when they validate.
    const validationData =
      mode === 'coerce-on-failure' ? structuredClone(data) : data;
    const valid = validate(validationData);
    if (valid && validationData !== data) {
      Object.assign(data, validationData);
    }
    if (!valid && validate.errors) {
      return {
        message: errorsText(validator, validate.errors, validationData, 'params'),
        errors: validate.errors,
      };
    }
    return null;
  }

  /**
   * Validates a JSON schema itself. Returns null if the schema is valid,
   * otherwise returns a string describing the validation errors.
   */
  static validateSchema(schema: AnySchema | undefined): string | null {
    if (!schema) {
      return null;
    }
    const validator = getValidator(schema);
    try {
      const isValid = validator.validateSchema(schema);
      return isValid ? null : validator.errorsText(validator.errors);
    } catch (error) {
      // Schema validation failed (unsupported version, etc.)
      // Skip validation rather than blocking tool usage.
      runLogger.warn(
        `Failed to validate schema (${
          (schema as Record<string, unknown>)?.['$schema'] ?? '<no $schema>'
        }): ${error instanceof Error ? error.message : String(error)}. ` +
          'Skipping schema validation.',
      );
      return null;
    }
  }
}
