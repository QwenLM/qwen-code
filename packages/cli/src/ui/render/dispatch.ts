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

// OpenTUI is the default renderer; runtimes that cannot load its native
// backend (no bun:ffi / node:ffi) silently fall back to ink at startup, and
// `QWEN_TUI_RENDERER=ink` forces ink on any runtime. An explicit
// `QWEN_TUI_RENDERER=opentui` on an unsupported runtime fails loudly via
// ensureOpenTuiRuntimeSupported instead of downgrading (see startInteractiveUI).
export const DEFAULT_RENDERER: RendererId = 'opentui';

export const EXPERIMENTAL_RENDERER: RendererId = 'opentui';

export function rendererExplicitlyRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const requested = env[RENDERER_ENV_VAR]?.trim();
  return requested === 'ink' || requested === EXPERIMENTAL_RENDERER;
}

export function pickRenderer(env: NodeJS.ProcessEnv = process.env): RendererId {
  const requested = env[RENDERER_ENV_VAR]?.trim();
  if (requested === 'ink') return 'ink';
  if (requested === EXPERIMENTAL_RENDERER) return EXPERIMENTAL_RENDERER;
  return DEFAULT_RENDERER;
}

export function isExperimentalRenderer(id: RendererId): boolean {
  return id === EXPERIMENTAL_RENDERER;
}
