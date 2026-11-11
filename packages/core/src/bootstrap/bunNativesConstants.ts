/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared stderr marker for bootstrap diagnostics and build smoke checks.
// Keep this module free of bootstrap's import-time startup side effects.
export const BUN_NATIVE_EXTRACTION_FAILURE_MARKER =
  'failed to extract native modules';
