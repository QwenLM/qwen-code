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

// Lowlight is loaded asynchronously in production to keep it out of the
// startup-critical bundle chunk. Snapshot tests render synchronously via
// `lastFrame()` and would otherwise capture the plain-text fallback before
// the dynamic import resolves. Prime the cache once here so every test sees
// the fully-highlighted output. The loader is intentionally a tiny standalone
// module (no transitive imports of themeManager / settings / core) so this
// prime does not perturb any other test's module graph.
import { loadLowlight } from './src/ui/utils/lowlightLoader.js';
await loadLowlight();
