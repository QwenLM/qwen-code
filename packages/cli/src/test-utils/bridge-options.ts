/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Bridge's options other than its channels, for comparing two
 * constructions: values as they are, and the functions and class instances
 * that every construction creates anew by kind.
 */
export function comparableBridgeOptions(
  options: object,
  ignored: readonly string[] = [],
): unknown {
  return comparable(
    Object.fromEntries(
      Object.entries(options).filter(
        ([key]) =>
          key !== 'channelFactory' &&
          key !== 'executionEngines' &&
          !ignored.includes(key),
      ),
    ),
    [],
  );
}

function comparable(value: unknown, ancestors: readonly object[]): unknown {
  if (typeof value === 'function') return 'function';
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.includes(value)) return 'cycle';
  const within = [...ancestors, value];
  if (Array.isArray(value)) {
    return value.map((entry) => comparable(entry, within));
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return `instance of ${prototype.constructor.name}`;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      comparable(entry, within),
    ]),
  );
}
