/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utility functions for settings migrations.
 *
 * These functions provide common operations needed during migration,
 * such as manipulating nested properties and transforming values.
 */

import type { MigrationChange } from './types.js';

/**
 * Gets a value from a nested object path.
 *
 * @param obj - The object to traverse
 * @param path - Dot-separated path (e.g., 'general.disableAutoUpdate')
 * @returns The value at the path, or undefined if not found
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;

  for (const key of keys) {
    if (typeof current !== 'object' || current === null || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

/**
 * Sets a value at a nested object path, creating intermediate objects as needed.
 *
 * @param obj - The object to modify
 * @param path - Dot-separated path (e.g., 'general.disableAutoUpdate')
 * @param value - The value to set
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split('.');
  const lastKey = keys.pop();
  if (!lastKey) return;

  let current: Record<string, unknown> = obj;
  for (const key of keys) {
    if (current[key] === undefined) {
      current[key] = {};
    }
    const next = current[key];
    if (typeof next === 'object' && next !== null) {
      current = next as Record<string, unknown>;
    } else {
      // This path is invalid, so we stop.
      return;
    }
  }
  current[lastKey] = value;
}

/**
 * Deletes a property at a nested object path.
 *
 * @param obj - The object to modify
 * @param path - Dot-separated path (e.g., 'general.disableAutoUpdate')
 */
export function deleteNestedProperty(
  obj: Record<string, unknown>,
  path: string,
): void {
  const keys = path.split('.');
  const lastKey = keys.pop();
  if (!lastKey) return;

  let current: Record<string, unknown> = obj;
  for (const key of keys) {
    const next = current[key];
    if (typeof next !== 'object' || next === null) {
      return;
    }
    current = next as Record<string, unknown>;
  }
  delete current[lastKey];
}

/**
 * Moves a field from one path to another.
 *
 * @param data - The object to modify
 * @param from - Source path (e.g., 'theme')
 * @param to - Destination path (e.g., 'ui.theme')
 * @returns The change record, or null if source doesn't exist
 */
export function moveField(
  data: Record<string, unknown>,
  from: string,
  to: string,
): MigrationChange | null {
  const value = getNestedValue(data, from);
  if (value === undefined) {
    return null;
  }

  setNestedValue(data, to, value);
  deleteNestedProperty(data, from);

  return {
    type: 'move',
    path: to,
    oldValue: value,
    newValue: value,
    reason: `Moved from ${from} to ${to}`,
  };
}

/**
 * Renames a field, optionally transforming its value.
 *
 * @param data - The object to modify
 * @param from - Source path (e.g., 'general.disableAutoUpdate')
 * @param to - Destination path (e.g., 'general.enableAutoUpdate')
 * @param transform - Optional function to transform the value
 * @returns The change record, or null if source doesn't exist
 */
export function renameField(
  data: Record<string, unknown>,
  from: string,
  to: string,
  transform?: (value: unknown) => unknown,
): MigrationChange | null {
  const oldValue = getNestedValue(data, from);
  if (oldValue === undefined) {
    return null;
  }

  const newValue = transform ? transform(oldValue) : oldValue;
  setNestedValue(data, to, newValue);
  deleteNestedProperty(data, from);

  return {
    type: transform ? 'transform' : 'rename',
    path: to,
    oldValue,
    newValue,
    reason: transform
      ? `Renamed from ${from} to ${to} with value transformation`
      : `Renamed from ${from} to ${to}`,
  };
}

/**
 * Inverts a boolean value.
 *
 * @param value - The value to invert
 * @returns The inverted boolean, or the original value if not a boolean
 */
export function invertBoolean(value: unknown): unknown {
  if (typeof value === 'boolean') {
    return !value;
  }
  return value;
}

/**
 * Consolidates multiple source fields into a single target field.
 *
 * The merge function receives an array of values (in the order of source paths)
 * and should return the merged result.
 *
 * @param data - The object to modify
 * @param sources - Array of source paths
 * @param target - Target path for the merged value
 * @param mergeFn - Function to merge source values
 * @returns The change record, or null if no sources exist
 */
export function consolidateFields(
  data: Record<string, unknown>,
  sources: string[],
  target: string,
  mergeFn: (values: unknown[]) => unknown,
): MigrationChange | null {
  const values: unknown[] = [];
  const foundSources: string[] = [];

  for (const source of sources) {
    const value = getNestedValue(data, source);
    if (value !== undefined) {
      values.push(value);
      foundSources.push(source);
    }
  }

  if (values.length === 0) {
    return null;
  }

  const mergedValue = mergeFn(values);
  setNestedValue(data, target, mergedValue);

  // Delete all source fields
  for (const source of foundSources) {
    deleteNestedProperty(data, source);
  }

  return {
    type: 'transform',
    path: target,
    oldValue: values,
    newValue: mergedValue,
    reason: `Consolidated ${foundSources.join(', ')} into ${target}`,
  };
}

/**
 * Preserves unknown fields from source in target.
 *
 * @param source - The source object containing unknown fields
 * @param target - The target object to preserve fields in
 * @param knownFields - Set of known field names to exclude
 * @returns Array of warnings for each preserved field
 */
export function preserveUnknownFields(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  knownFields: Set<string>,
): string[] {
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (!knownFields.has(key)) {
      // Preserve the unknown field
      target[key] = value;
      warnings.push(`Unknown field preserved: ${key}`);
    }
  }

  return warnings;
}

/**
 * Creates a deep clone of an object.
 *
 * @param obj - The object to clone
 * @returns A deep clone of the object
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}
