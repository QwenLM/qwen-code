/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const appendFileSync = vi.fn();
  return {
    ...actual,
    appendFileSync,
    default: {
      ...actual,
      appendFileSync,
    },
  };
});
