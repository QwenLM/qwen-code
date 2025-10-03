/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Simple YAML parser for subagent frontmatter.
 * This is a minimal implementation that handles the basic YAML structures
 * needed for subagent configuration files.
 */

/**
 * Parses a simple YAML string into a JavaScript object.
 * Supports basic key-value pairs, arrays, and nested objects.
 *
 * @param yamlString - YAML string to parse
 * @returns Parsed object
 */
export function parse(yamlString: string): Record<string, unknown> {
  const lines = yamlString
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'));
  const result: Record<string, unknown> = {};

  let currentKey = '';
  let currentArray: unknown[] = [];
  let inArray = false;
  let currentObject: Record<string, unknown> = {};
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
      currentObject = {};
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
            currentObject = {};
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
