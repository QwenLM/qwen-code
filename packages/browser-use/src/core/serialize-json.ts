/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// This function is also sent to the page; keep it independent of module bindings.
export function serializeJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || ancestors.has(item))
      throw new TypeError('Value must be JSON-serializable');
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (
      (!array &&
        prototype !== null &&
        Object.getPrototypeOf(prototype) !== null) ||
      Object.getOwnPropertySymbols(item).some((key) =>
        Object.prototype.propertyIsEnumerable.call(item, key),
      )
    )
      throw new TypeError('Value must be JSON-serializable');
    ancestors.add(item);
    try {
      if (array) {
        const length = item.length;
        if (Object.keys(item).length !== length)
          throw new TypeError('Value must be JSON-serializable');
        const entries: string[] = [];
        for (let index = 0; index < length; index++)
          entries.push(encode(item[index]));
        return '[' + entries.join(',') + ']';
      }
      return (
        '{' +
        Object.entries(item)
          .map(([key, entry]) => JSON.stringify(key) + ':' + encode(entry))
          .join(',') +
        '}'
      );
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value);
}
