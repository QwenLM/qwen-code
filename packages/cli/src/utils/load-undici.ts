/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type UndiciModule = typeof import('undici');

export type { UndiciModule };

let undiciModulePromise: Promise<UndiciModule> | undefined;

/**
 * Load undici behind a dynamic import so it stays out of the eager startup
 * closure (issue #7264). esbuild compiles the CJS undici package into a
 * default-only dynamic chunk (no named exports), while Node and vitest
 * expose named exports directly — unwrap only the default-only shape.
 *
 * Kept package-local (mirroring core's loadUndici) so `vi.mock('undici')`
 * in cli tests intercepts the import; core resolves its own undici copy.
 */
export async function loadUndici(): Promise<UndiciModule> {
  undiciModulePromise ??= import('undici').then((mod) => {
    const keys = Object.keys(mod);
    if (keys.length === 1 && keys[0] === 'default') {
      return (mod as unknown as { default: UndiciModule }).default;
    }
    return mod;
  });
  return undiciModulePromise;
}
