/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixed capture viewport — the single source of truth shared by
 * playwright.visuals.config.ts and the visuals harness/specs, so the value
 * cannot drift between the config and what actually renders.
 */
export const VISUAL_VIEWPORT = { width: 1280, height: 800 } as const;
