/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as yaml from 'yaml';
import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('YAML_PARSER');

/**
 * Parses a YAML string with full spec support (block scalars, nested
 * structures, etc.), falling back to the simple parser on failure so
 * that slightly malformed frontmatter still loads where possible.
 *
 * @param yamlString - YAML string to parse
 * @returns Parsed object
 */
export function parse(yamlString: string): Record<string, unknown> {
  try {
    const result = yaml.parse(yamlString, {
      schema: 'core',
      // Belt-and-suspenders: filter timestamp/binary from schema tags.
      // The core schema doesn't include them, so this is a no-op in
      // practice — the real defense is in sanitizeValue() which catches
      // Date/Uint8Array from explicit !!tags that bypass schema filtering.
      customTags: (tags) =>
        tags.filter((tag) => {
          const uri = typeof tag === 'string' ? tag : tag.tag;
          return (
            uri !== 'tag:yaml.org,2002:timestamp' &&
            uri !== 'tag:yaml.org,2002:binary' &&
            uri !== 'timestamp' &&
            uri !== 'binary'
          );
        }),
    });
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return stripNullValues(result as Record<string, unknown>);
    }
    debugLogger.warn(
      `Full YAML parser returned non-object (${typeof result}), falling back to simple parser`,
    );
  } catch (error) {
    debugLogger.warn(
      `Full YAML parser failed, falling back to simple parser: ${error}`,
    );
  }
  return stripNullValues(parseSimple(yamlString));
}

/**
 * Recursively sanitizes parsed YAML values:
 * - Strips null values so callers can use `!== undefined` consistently
 * - Converts Date / Uint8Array (from explicit !!tags) back to strings
 * - Wraps nested objects in null-prototype containers to prevent
 *   prototype pollution via `__proto__` keys
 */
function sanitizeValue(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }
  // Explicit YAML tags (!!timestamp, !!binary) bypass schema filtering
  // and produce Date / Uint8Array objects. Coerce them back to strings
  // so downstream code that expects plain JSON-style values stays safe.
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  // Recurse into nested plain objects so __proto__ / Date / Uint8Array
  // values inside hooks or metadata are also sanitized.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return stripNullValues(value as Record<string, unknown>);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue).filter((v) => v !== undefined);
  }
  return value;
}

function stripNullValues(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  // Object.create(null) prevents prototype pollution: a YAML key of
  // "__proto__" becomes a plain own property instead of triggering the
  // __proto__ setter that would replace the object's prototype.
  const cleaned = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const sanitized = sanitizeValue(value);
    if (sanitized !== undefined) {
      cleaned[key] = sanitized;
    }
  }
  return cleaned;
}

/**
 * Simple YAML parser for subagent frontmatter.
 * This is a minimal implementation that handles the basic YAML structures
 * needed for subagent configuration files.
 *
 * @param yamlString - YAML string to parse
 * @returns Parsed object
 */
function parseSimple(yamlString: string): Record<string, unknown> {
  const lines = yamlString
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'));
  const result = Object.create(null) as Record<string, unknown>;

  let currentKey = '';
  let currentArray: unknown[] = [];
  let inArray = false;
  let currentObject = Object.create(null) as Record<string, unknown>;
  let inObject = false;
  let objectKey = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Handle array items
    if (line.startsWith('  - ')) {
      if (!inArray) {
        inArray = true;
        currentArray = [];
      }
      const itemRaw = line.substring(4).trim();
      currentArray.push(parseValue(itemRaw));
      continue;
    }

    // End of array
    if (inArray && !line.startsWith('  - ')) {
      result[currentKey] = currentArray;
      inArray = false;
      currentArray = [];
      currentKey = '';
    }

    // Handle nested object items (simple indentation)
    if (line.startsWith('  ') && inObject) {
      const [key, ...valueParts] = line.trim().split(':');
      const value = valueParts.join(':').trim();
      currentObject[key.trim()] = parseValue(value);
      continue;
    }

    // End of object
    if (inObject && !line.startsWith('  ')) {
      result[objectKey] = currentObject;
      inObject = false;
      currentObject = Object.create(null) as Record<string, unknown>;
      objectKey = '';
    }

    // Handle key-value pairs
    if (line.includes(':')) {
      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':').trim();

      if (value === '') {
        // This might be the start of an object or array
        currentKey = key.trim();

        // Look ahead to determine if this is an array or object
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          if (nextLine.startsWith('  - ')) {
            // Next line is an array item, so this will be handled in the next iteration
            continue;
          } else if (nextLine.startsWith('  ')) {
            // Next line is indented, so this is an object
            inObject = true;
            objectKey = currentKey;
            currentObject = Object.create(null) as Record<string, unknown>;
            currentKey = '';
            continue;
          }
        }
      } else {
        result[key.trim()] = parseValue(value);
      }
    }
  }

  // Handle remaining array or object
  if (inArray) {
    result[currentKey] = currentArray;
  }
  if (inObject) {
    result[objectKey] = currentObject;
  }

  return result;
}

/**
 * Converts a JavaScript object to a simple YAML string.
 *
 * @param obj - Object to stringify
 * @param options - Stringify options
 * @returns YAML string
 */
export function stringify(
  obj: Record<string, unknown>,
  _options?: { lineWidth?: number; minContentWidth?: number },
): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${formatValue(item)}`);
      }
    } else if (typeof value === 'object' && value !== null) {
      lines.push(`${key}:`);
      for (const [subKey, subValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        lines.push(`  ${subKey}: ${formatValue(subValue)}`);
      }
    } else {
      lines.push(`${key}: ${formatValue(value)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Parses a value string into appropriate JavaScript type.
 */
function parseValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value === '') return '';

  // Handle quoted strings
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    const unquoted = value.slice(1, -1);
    // Unescape quotes and backslashes
    return unquoted.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  // Try to parse as number
  const num = Number(value);
  if (!isNaN(num) && isFinite(num)) {
    return num;
  }

  // Return as string
  return value;
}

/**
 * Formats a value for YAML output.
 */
function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    // Quote strings that might be ambiguous or contain special characters
    if (
      value.includes(':') ||
      value.includes('#') ||
      value.includes('"') ||
      value.includes('\\') ||
      value.trim() !== value
    ) {
      // Escape backslashes THEN quotes
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  }

  return String(value);
}
