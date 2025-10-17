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
const ajValidator = new AjvClass({ coerceTypes: true });
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
    const valid = validate(data);
    if (!valid && validate.errors) {
      // Find any True or False values and lowercase them
      fixBooleanCasing(data as Record<string, unknown>);

      const validate = ajValidator.compile(schema);
      const valid = validate(data);

      if (!valid && validate.errors) {
        return ajValidator.errorsText(validate.errors, { dataVar: 'params' });
      }
    }
    return null;
  }
}

function fixBooleanCasing(data: Record<string, unknown>) {
  for (const key of Object.keys(data)) {
    if (!(key in data)) continue;

    if (typeof data[key] === 'object') {
      fixBooleanCasing(data[key] as Record<string, unknown>);
    } else if (data[key] === 'True') data[key] = 'true';
    else if (data[key] === 'False') data[key] = 'false';
  }
}
