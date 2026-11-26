/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// A top-level field to track the total number of active animated components.
// This is used for testing to ensure we wait for animations to finish.
export const debugState = {
  debugNumAnimatedComponents: 0,
};
