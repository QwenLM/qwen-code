/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Resource is a lower layer than Core. Read the same build-time brand field
// here without importing Core or adding a second public package entrypoint.
export const BRAND_FIXED_ENV_PREFIX =
  process.env['BRAND_FIXED_ENV_PREFIX'] || 'QWEN_';
