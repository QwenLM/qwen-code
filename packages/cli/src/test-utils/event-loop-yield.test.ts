/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { setTimeout as realSetTimeout } from 'node:timers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe.each([false, true])(
  'test-boundary yield (fake timers: %s)',
  (fake) => {
    let macrotaskRan = false;

    beforeAll(() => {
      if (fake) vi.useFakeTimers();
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it('queues a real macrotask from a synchronous test', () => {
      realSetTimeout(() => {
        macrotaskRan = true;
      }, 0);
    });

    it('drains the macrotask before the next synchronous test', () => {
      expect(macrotaskRan).toBe(true);
    });
  },
);
