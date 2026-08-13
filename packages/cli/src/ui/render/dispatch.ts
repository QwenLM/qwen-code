/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer dispatch for the interactive TUI. `QWEN_TUI_RENDERER=opentui`
 * selects the experimental OpenTUI renderer; any other value (or none)
 * keeps the default ink renderer. Pure TypeScript with no framework
 * imports: both renderer entries depend on this module, never the other
 * way around (see scripts/check-tui-dep-direction.mjs).
 */

export type RendererId = 'ink' | 'opentui';

export const RENDERER_ENV_VAR = 'QWEN_TUI_RENDERER';

// Ink remains the default until the OpenTUI TUI reaches feature parity, so the
// real CLI stays fully usable (same as qwen-code today). OpenTUI is the new
// renderer, selectable via `QWEN_TUI_RENDERER=opentui`; it becomes the default
// (and ink is removed) in the release commit after parity + regression.
export const DEFAULT_RENDERER: RendererId = 'opentui';

export const EXPERIMENTAL_RENDERER: RendererId = 'opentui';

export function pickRenderer(env: NodeJS.ProcessEnv = process.env): RendererId {
  const requested = env[RENDERER_ENV_VAR]?.trim();
  if (requested === 'ink') return 'ink';
  if (requested === EXPERIMENTAL_RENDERER) return EXPERIMENTAL_RENDERER;
  return DEFAULT_RENDERER;
}

export function isExperimentalRenderer(id: RendererId): boolean {
  return id === EXPERIMENTAL_RENDERER;
}
