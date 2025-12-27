/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import AjvPkg from 'ajv';
import * as addFormats from 'ajv-formats';
// Ajv's ESM/CJS interop: use 'any' for compatibility as recommended by Ajv docs
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvClass = (AjvPkg as any).default || AjvPkg;
const ajValidator = new AjvClass(
  // See: https://ajv.js.org/options.html#strict-mode-options
  {
    // strictSchema defaults to true and prevents use of JSON schemas that
    // include unrecognized keywords. The JSON schema spec specifically allows
    // for the use of non-standard keywords and the spec-compliant behavior
    // is to ignore those keywords. Note that setting this to false also
    // allows use of non-standard or custom formats (the unknown format value
    // will be logged but the schema will still be considered valid).
    strictSchema: false,
  },
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormatsFunc = (addFormats as any).default || addFormats;
addFormatsFunc(ajValidator);

/**
 * Simple utility to validate objects against JSON Schemas
 */
export class SchemaValidator {
  /**
   * Returns null if the data confroms to the schema described by schema (or if schema
   *  is null). Otherwise, returns a string describing the error.
   */
  static validate(schema: unknown | undefined, data: unknown): string | null {
    if (!schema) {
      return null;
    }
    if (typeof data !== 'object' || data === null) {
      return 'Value of params must be an object';
    }
    const validate = ajValidator.compile(schema);
    let valid = validate(data);
    if (!valid && validate.errors) {
      // Coerce string boolean values ("true"/"false") to actual booleans
      fixBooleanValues(data as Record<string, unknown>);

      valid = validate(data);
      if (!valid && validate.errors) {
        return ajValidator.errorsText(validate.errors, { dataVar: 'params' });
      }
    }
    return null;
  }
}

/**
 * Coerces string boolean values to actual booleans.
 * This handles cases where LLMs return "true"/"false" strings instead of boolean values,
 * which is common with self-hosted LLMs.
 *
 * Converts:
 * - "true", "True", "TRUE" -> true
 * - "false", "False", "FALSE" -> false
 */
function fixBooleanValues(data: Record<string, unknown>) {
  for (const key of Object.keys(data)) {
    if (!(key in data)) continue;
    const value = data[key];

    if (typeof value === 'object' && value !== null) {
      fixBooleanValues(value as Record<string, unknown>);
    } else if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'true') {
        data[key] = true;
      } else if (lower === 'false') {
        data[key] = false;
      }
    }
  }
}
