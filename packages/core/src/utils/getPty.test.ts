/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, afterEach } from 'vitest';
import { getPty, BUN_FORCE_PTY_ENV_VAR } from './getPty.js';

function withBunVersion(fn: () => Promise<void> | void): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process.versions, 'bun');
  Object.defineProperty(process.versions, 'bun', {
    value: '1.3.8',
    configurable: true,
  });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (original) {
        Object.defineProperty(process.versions, 'bun', original);
      } else {
        const versions = process.versions as typeof process.versions & {
          bun?: string;
        };
        delete versions.bun;
      }
    });
}

describe('getPty', () => {
  afterEach(() => {
    delete process.env[BUN_FORCE_PTY_ENV_VAR];
  });

  it('falls back when running under Bun', () =>
    withBunVersion(async () => {
      delete process.env[BUN_FORCE_PTY_ENV_VAR];
      await expect(getPty()).resolves.toBeNull();
    }));

  it('honours the force-PTY opt-in under Bun', () =>
    withBunVersion(async () => {
      process.env[BUN_FORCE_PTY_ENV_VAR] = '1';
      // With the opt-in set the Bun guard must not short-circuit, so the
      // loader resolves the installed @lydell/node-pty (the repo ships it).
      const result = await getPty();
      expect(result).not.toBeNull();
      expect(result?.name).toBe('lydell-node-pty');
    }));
});
