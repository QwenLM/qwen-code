/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getPty } from './getPty.js';

describe('getPty', () => {
  it('falls back when running under Bun', async () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, 'bun');

    Object.defineProperty(process.versions, 'bun', {
      value: '1.3.8',
      configurable: true,
    });

    try {
      await expect(getPty()).resolves.toBeNull();
    } finally {
      if (original) {
        Object.defineProperty(process.versions, 'bun', original);
      } else {
        const versions = process.versions as typeof process.versions & {
          bun?: string;
        };
        delete versions.bun;
      }
    }
  });
});
