/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { BackgroundContinuationRegistry } from './background-continuation-registry.js';

describe(
  'background continuation records',
  () => {
    it(
      'clears only the retiring runtime when the same session is reopened',
      () => {
        const registry = new BackgroundContinuationRegistry();
        const oldOwner = {};
        const newOwner = {};
        registry.register(
          's',
          'old',
          oldOwner
        );
        registry.register(
          's',
          'new',
          newOwner
        );
        registry.clearOwner(oldOwner);
        expect(registry.isPending(
          's',
          'old'
        )).toBe(false);
        expect(registry.isPending(
          's',
          'new'
        )).toBe(true);
      }
    );
    it(
      'keeps independent notifications pending until consumed or discarded',
      () => {
        const registry = new BackgroundContinuationRegistry();
        const first = registry.register(
          'session',
          'business'
        );
        const second = registry.register(
          'session',
          'business'
        );
        registry.register(
          'other',
          'business'
        );
        expect(first).not.toBe(second);
        registry.consume([first, first]);
        expect(registry.isPending(
          'session',
          'business'
        )).toBe(true);
        registry.discard([second, second]);
        expect(registry.isPending(
          'session',
          'business'
        )).toBe(false);
        expect(registry.isPending(
          'other',
          'business'
        )).toBe(true);
        registry.clearSession('other');
        registry.clearSession('other');
        expect(registry.isPending(
          'other',
          'business'
        )).toBe(false);
      }
    );
  }
);
