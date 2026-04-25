/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Unset NO_COLOR environment variable to ensure consistent theme behavior between local and CI test runs
if (process.env['NO_COLOR'] !== undefined) {
  delete process.env['NO_COLOR'];
}

// Avoid writing per-session debug log files during CLI tests.
// Individual tests can still opt in by overriding this env var explicitly.
if (process.env['QWEN_DEBUG_LOG_FILE'] === undefined) {
  process.env['QWEN_DEBUG_LOG_FILE'] = '0';
}

import './src/test-utils/customMatchers.js';

// Note on FileIndexService: tests that exercise the worker-backed file
// search must opt in to the in-process transport via a local `beforeAll`
// (see e.g. `src/ui/hooks/useAtCompletion.test.ts`). Installing it here
// would eagerly evaluate `@qwen-code/qwen-code-core`'s module tree —
// including `workspaceContext.ts` with a real `node:fs` binding — before
// any `vi.mock('fs', …)` in an individual test file can take effect,
// breaking tests that rely on those mocks (e.g. `config.test.ts` bare
// mode). Keep this file free of eager core imports.
