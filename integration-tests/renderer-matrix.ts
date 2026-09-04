/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer matrix for interactive E2E tests.
 *
 * `QWEN_E2E_RENDERER` selects which renderer the interactive suite drives:
 *   - 'ink' (default): node runs dist/cli.js with QWEN_TUI_RENDERER=ink.
 *   - 'opentui': bun runs dist/cli.js with QWEN_TUI_RENDERER=opentui.
 *
 * The overlay pins the renderer for the spawned CLI, and the opentui leg
 * also sets QWEN_TUI_RENDERER_STRICT: the product gate (selectTuiRenderer)
 * silently falls back to ink on a runtime that cannot load the native
 * renderer, and strict mode turns that fallback into a loud startup failure
 * — so a green opentui run really exercised the OpenTUI renderer, and a
 * green ink run cannot have been served by a fallback.
 *
 * The default stays 'ink' until the ink removal lands: every existing
 * runner (node-only CI legs, developer machines without bun) keeps its
 * current behavior, and the opentui leg is opted into via env or the
 * `test:integration:interactive:opentui:*` scripts.
 */

import { spawnSync } from 'node:child_process';

export type E2eRenderer = 'ink' | 'opentui';

export const E2E_RENDERER_ENV_VAR = 'QWEN_E2E_RENDERER';

export function pickE2eRenderer(
  env: NodeJS.ProcessEnv = process.env,
): E2eRenderer {
  const requested = env[E2E_RENDERER_ENV_VAR]?.trim().toLowerCase();
  if (requested === 'opentui') return 'opentui';
  return 'ink';
}

/**
 * Command that launches the CLI bundle under the selected renderer: node for
 * ink, bun for opentui (the locked @opentui/core needs bun:ffi — CI node
 * builds cannot load node:ffi).
 */
export function resolveE2eCliCommand(renderer: E2eRenderer): string {
  if (renderer === 'ink') return 'node';
  const probe = spawnSync('bun', ['--version'], { encoding: 'utf-8' });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `${E2E_RENDERER_ENV_VAR}=opentui requires bun to load the OpenTUI ` +
        `native renderer, but \`bun\` was not found on PATH. Install bun ` +
        `(https://bun.sh) or unset ${E2E_RENDERER_ENV_VAR}.`,
    );
  }
  return 'bun';
}

/**
 * Env overlay pinning the renderer for a spawned CLI process. The opentui
 * leg carries QWEN_TUI_RENDERER_STRICT so a boot-time ink fallback fails the
 * run instead of passing as a false green (see the module docs).
 */
export function e2eRendererEnv(renderer: E2eRenderer): Record<string, string> {
  if (renderer === 'opentui') {
    return { QWEN_TUI_RENDERER: renderer, QWEN_TUI_RENDERER_STRICT: '1' };
  }
  return { QWEN_TUI_RENDERER: renderer };
}
