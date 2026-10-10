/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export default {
  test: {
    include: ['**/*.fixture.ts'],
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    isolate: true,
    retry: 0,
    coverage: { enabled: false },
  },
};
