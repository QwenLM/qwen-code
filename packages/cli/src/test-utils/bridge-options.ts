/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

/**
 * The options of the Bridges one construction built, other than their
 * channels, for comparing it with another construction of the same Bridges.
 * Values are kept as they are. A function is described by its source and a
 * class instance by its class, each with a number that the Bridges built by
 * that construction share exactly when they share the value, so a Bridge
 * that swaps in a different function or instance, or stops sharing one,
 * differs even though every construction creates its own.
 */
export function comparableBridgeOptions(
  optionsList: readonly object[],
): unknown[] {
  const identities = new Map<object, number>();
  const identity = (value: object) => {
    let id = identities.get(value);
    if (id === undefined) {
      id = identities.size + 1;
      identities.set(value, id);
    }
    return id;
  };
  const comparable = (
    value: unknown,
    ancestors: readonly object[],
  ): unknown => {
    if (typeof value === 'function') {
      const source = createHash('sha256')
        .update(Function.prototype.toString.call(value))
        .digest('hex')
        .slice(0, 12);
      return `function ${source} #${identity(value)}`;
    }
    if (value === null || typeof value !== 'object') return value;
    if (ancestors.includes(value)) return 'cycle';
    const within = [...ancestors, value];
    if (Array.isArray(value)) {
      return value.map((entry) => comparable(entry, within));
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      return `instance of ${prototype.constructor.name} #${identity(value)}`;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        comparable(entry, within),
      ]),
    );
  };
  return optionsList.map((options) =>
    comparable(
      Object.fromEntries(
        Object.entries(options).filter(
          ([key]) => key !== 'channelFactory' && key !== 'executionEngines',
        ),
      ),
      [],
    ),
  );
}
