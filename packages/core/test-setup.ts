/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Unset NO_COLOR environment variable to ensure consistent theme behavior between local and CI test runs
if (process.env['NO_COLOR'] !== undefined) {
  delete process.env['NO_COLOR'];
}

import { setSimulate429 } from './src/utils/testUtils.js';

// Avoid writing per-session debug log files during tests.
// Unit tests can opt-in by overriding this env var.
if (process.env['QWEN_DEBUG_LOG_FILE'] === undefined) {
  process.env['QWEN_DEBUG_LOG_FILE'] = '0';
}

// Disable 429 simulation globally for all tests
setSimulate429(false);

// Keep managed auto-memory test fixtures under per-test temp project roots.
if (process.env['QWEN_CODE_MEMORY_LOCAL'] === undefined) {
  process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
}

// Some dependencies (e.g., undici) expect a global File constructor in Node.
// Provide a minimal shim for test environment if missing.
if (typeof (globalThis as unknown as { File?: unknown }).File === 'undefined') {
  (globalThis as unknown as { File: unknown }).File = class {} as unknown;
}

// Note on FileIndexService: the default transport spawns a real Node worker
// thread loading the compiled `fileIndexWorker.js`, which vitest can't use
// when executing TS sources directly. Tests that exercise FileIndexService
// must opt in to the in-process transport via a local `beforeAll` —
// installing it here would eagerly pull `src/index.ts` (and thus
// `workspaceContext.ts` with a real `node:fs` binding) into every test
// file's module graph, breaking tests that rely on `vi.mock('fs', …)`
// (e.g. `packages/cli/src/config/config.test.ts` bare-mode cases).
