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
 * `QWEN_E2E_RUNTIME=bun` also runs the Ink leg on Bun, separating runtime
 * regressions (Node+Ink vs Bun+Ink) from renderer regressions (Bun+Ink vs
 * Bun+OpenTUI). Missing runtimes and invalid selections fail the run.
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
export const E2E_RUNTIME_ENV_VAR = 'QWEN_E2E_RUNTIME';

export function pickE2eRenderer(
  env: NodeJS.ProcessEnv = process.env,
): E2eRenderer {
  const requested = env[E2E_RENDERER_ENV_VAR]?.trim().toLowerCase();
  if (!requested || requested === 'ink') return 'ink';
  if (requested === 'opentui') return requested;
  throw new Error(
    `${E2E_RENDERER_ENV_VAR} must be ink or opentui; received ${requested}.`,
  );
}

/**
 * Command that launches the CLI bundle under the selected renderer: node for
 * ink, bun for opentui (the locked @opentui/core needs bun:ffi — CI node
 * builds cannot load node:ffi).
 */
export function resolveE2eCliCommand(
  renderer: E2eRenderer,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const requested = env[E2E_RUNTIME_ENV_VAR]?.trim().toLowerCase();
  const runtime = requested || (renderer === 'opentui' ? 'bun' : 'node');
  if (runtime !== 'node' && runtime !== 'bun') {
    throw new Error(
      `${E2E_RUNTIME_ENV_VAR} must be node or bun; received ${runtime}.`,
    );
  }
  if (renderer === 'opentui' && runtime !== 'bun') {
    throw new Error(
      `${E2E_RENDERER_ENV_VAR}=opentui requires bun in the E2E matrix; ` +
        `set ${E2E_RUNTIME_ENV_VAR}=bun.`,
    );
  }
  if (runtime === 'node') return runtime;
  const probe = spawnSync('bun', ['--version'], { encoding: 'utf-8' });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `The ${runtime}+${renderer} E2E leg requires bun, but \`bun --version\` ` +
        `failed. Install bun (https://bun.sh) and rerun the same leg.`,
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
