/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const previousValues = new Map<string, string | undefined>();

export function setInvocationScopedEnv(name: string, value: string): void {
  if (!previousValues.has(name)) {
    previousValues.set(name, process.env[name]);
  }
  process.env[name] = value;
}

export function restoreInvocationScopedEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const restored = { ...env };
  for (const [name, previous] of previousValues) {
    if (previous === undefined) {
      delete restored[name];
    } else {
      restored[name] = previous;
    }
  }
  return restored;
}
