/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Unset NO_COLOR environment variable to ensure consistent theme behavior between local and CI test runs
if (process.env['NO_COLOR'] !== undefined) {
  delete process.env['NO_COLOR'];
}

import { setSimulate429 } from '../utils/testUtils.js';
import { vi, afterEach } from 'vitest';
import { coreEvents } from '../utils/events.js';

// Core tests use the static constants exported by config/brand.ts.

// Increase max listeners to avoid warnings in large test suites
coreEvents.setMaxListeners(100);

// Disable 429 simulation globally for all tests
setSimulate429(false);

afterEach(() => {
  vi.unstubAllEnvs();
});

// Default mocks for Storage to prevent disk access in most tests.
// These can be overridden in specific tests using vi.unmock().

vi.mock('../config/storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/storage.js')>();
  actual.Storage.prototype.initialize = vi.fn(() => Promise.resolve(undefined));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (actual.Storage.prototype as any).getProjectIdentifier = vi.fn(
    () => 'project-slug',
  );
  return actual;
});
