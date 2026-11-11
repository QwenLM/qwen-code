/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';

/**
 * A fake implementation of PersistentState for testing.
 * It keeps state in memory and provides spies for get and set.
 */
export class FakePersistentState {
  private data: Record<string, unknown> = {};

  get = vi.fn().mockImplementation((key: string) => this.data[key]);

  set = vi.fn().mockImplementation((key: string, value: unknown) => {
    this.data[key] = value;
  });

  update = vi.fn().mockImplementation(
    (
      key: string,
      updater: (
        current: unknown,
      ) => { value: unknown; result: unknown } | undefined,
    ) => {
      const update = updater(this.data[key]);
      if (!update) return undefined;
      this.data[key] = update.value;
      return update.result;
    },
  );

  /**
   * Helper to reset the fake state between tests.
   */
  reset() {
    this.data = {};
    this.get.mockClear();
    this.set.mockClear();
    this.update.mockClear();
  }

  /**
   * Helper to clear mock call history without wiping data.
   */
  mockClear() {
    this.get.mockClear();
    this.set.mockClear();
  }

  /**
   * Re-bind the get/set implementations to the in-memory store. Needed because
   * `vi.restoreAllMocks()` (commonly called in a test's beforeEach) strips the
   * `mockImplementation` from these spies, which would otherwise leave `get`
   * returning undefined and `set` not persisting — silently breaking any test
   * that relies on reading back seeded data.
   */
  ensureImplementations() {
    this.get.mockImplementation((key: string) => this.data[key]);
    this.set.mockImplementation((key: string, value: unknown) => {
      this.data[key] = value;
    });
    this.update.mockImplementation(
      (
        key: string,
        updater: (
          current: unknown,
        ) => { value: unknown; result: unknown } | undefined,
      ) => {
        const update = updater(this.data[key]);
        if (!update) return undefined;
        this.data[key] = update.value;
        return update.result;
      },
    );
  }

  /**
   * Helper to set initial data for the fake.
   */
  setData(data: Record<string, unknown>) {
    this.data = { ...data };
  }
}
