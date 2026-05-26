/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Safely stringifies an object to JSON, handling circular references by replacing them with [Circular].
 *
 * Only true cycles (an object reachable from itself along the current ancestor
 * path) are replaced. Duplicate references (the same object appearing in
 * multiple sibling positions) are preserved as full copies, matching the
 * behavior of `JSON.stringify` on acyclic graphs.
 *
 * @param obj - The object to stringify
 * @param space - Optional space parameter for formatting (defaults to no formatting)
 * @returns JSON string with circular references replaced by [Circular]
 */
export function safeJsonStringify(
  obj: unknown,
  space?: string | number,
): string {
  const ancestors: object[] = [];
  return JSON.stringify(
    obj,
    function (this: unknown, _key, value) {
      if (typeof value !== 'object' || value === null) {
        return value;
      }
      // `this` is the parent of `value`. As JSON.stringify's DFS walk unwinds
      // back up the tree, pop any ancestors that are no longer on the path
      // to `this` so the stack reflects only the current chain of ancestors.
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop();
      }
      if (ancestors.includes(value as object)) {
        return '[Circular]';
      }
      ancestors.push(value as object);
      return value;
    },
    space,
  );
}
