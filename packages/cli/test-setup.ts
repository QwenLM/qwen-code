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

if (process.env['QWEN_SERVE_NO_PERSISTENT_REGISTRATION'] === undefined) {
  process.env['QWEN_SERVE_NO_PERSISTENT_REGISTRATION'] = '1';
}

// The review sandbox policy is the OPERATOR's setting for their own reviews,
// and this suite must not inherit it. A maintainer who turns the feature on
// and then runs `npm test` would otherwise watch the review tests refuse to
// run — 101 of them, measured — because the phase gates correctly do what the
// setting says. Deleting rather than pinning to a value, so `sandboxPolicy`'s
// "strictest of environment and settings" rule is left alone and a test that
// wants a policy still stubs one.
delete process.env['QWEN_REVIEW_SANDBOX'];
delete process.env['SANDBOX_SET_UID_GID'];

import './src/test-utils/customMatchers.js';

// Lowlight is loaded asynchronously in production to keep it out of the
// startup-critical bundle chunk. Snapshot tests render synchronously via
// `lastFrame()` and would otherwise capture the plain-text fallback before
// the dynamic import resolves. Prime the cache once here so every test sees
// the fully-highlighted output. The loader is intentionally a tiny standalone
// module (no transitive imports of themeManager / settings / core) so this
// prime does not perturb any other test's module graph.
import { loadLowlight } from './src/ui/utils/lowlightLoader.js';
try {
  await loadLowlight();
} catch (err) {
  // Don't crash the entire test run if lowlight fails to import; snapshot
  // tests that hit a code block will then render the plain-text fallback.
  console.warn(
    '[test-setup] Failed to prime lowlight cache, snapshot tests may ' +
      'show plain-text fallback:',
    String(err),
  );
}
