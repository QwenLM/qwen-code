/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Configuration data only; validation and defaults remain in Core.
export type JudgmentSettings =
  | { backend: 'typesafe'; model: string; baseUrl: string; apiKey: string }
  | { backend: 'bailian'; model: string };
