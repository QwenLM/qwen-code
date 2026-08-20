/**
 * View Custom Functions
 *
 * Pure helper functions registered as Filtrex `extraFunctions`.
 * Available in view expressions alongside built-in math functions.
 * All functions are safe, side-effect-free, and handle edge cases gracefully.
 */

import { extractLabelId } from '../labels/values';

/**
 * Days elapsed since a timestamp (in ms).
 * Returns 0 if timestamp is falsy or in the future.
 * @example daysSince(lastUsedAt) > 7
 */
function daysSince(timestamp: number): number {
  if (!timestamp || typeof timestamp !== 'number') return 0;
  const diff = Date.now() - timestamp;
  return diff > 0 ? diff / (1000 * 60 * 60 * 24) : 0;
}

/**
 * Hours elapsed since a timestamp (in ms).
 * Returns 0 if timestamp is falsy or in the future.
 * @example hoursSince(lastUsedAt) > 24
 */
function hoursSince(timestamp: number): number {
  if (!timestamp || typeof timestamp !== 'number') return 0;
  const diff = Date.now() - timestamp;
  return diff > 0 ? diff / (1000 * 60 * 60) : 0;
}

/**
 * Check if an array or string contains a value.
 * Works with label arrays and string fields.
 * For label arrays, also matches by extracted label ID so that
 * contains(labels, "priority") matches entries like "priority::3".
 * @example contains(labels, 'bug')
 * @example contains(name, 'feat')
 */
function contains(collection: unknown, value: unknown): boolean {
  if (Array.isArray(collection)) {
    return collection.some(item =>
      item === value ||
      (typeof item === 'string' && typeof value === 'string' && extractLabelId(item) === value)
    );
  }
  if (typeof collection === 'string' && typeof value === 'string') {
    return collection.includes(value);
  }
  return false;
}

/**
 * Get length of an array or string.
 * Returns 0 for non-array/non-string values.
 * @example length(labels) > 3
 * @example length(name) > 20
 */
function length(value: unknown): number {
  if (Array.isArray(value) || typeof value === 'string') {
    return value.length;
  }
  return 0;
}

/**
 * Check if a string starts with a prefix.
 * @example startsWith(name, 'feat')
 */
function startsWith(str: unknown, prefix: unknown): boolean {
  if (typeof str === 'string' && typeof prefix === 'string') {
    return str.startsWith(prefix);
  }
  return false;
}

/**
 * Convert string to lowercase for case-insensitive comparison.
 * @example lower(model) == 'opus'
 */
function lower(str: unknown): string {
  if (typeof str === 'string') {
    return str.toLowerCase();
  }
  return '';
}

/**
 * All custom functions to register with Filtrex.
 * Keys are the function names available in expressions.
 */
export const VIEW_FUNCTIONS: Record<string, Function> = {
  daysSince,
  hoursSince,
  contains,
  length,
  startsWith,
  lower,
};
