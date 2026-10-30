/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isOpenTuiRuntimeSupported,
  MIN_BUN_VERSION,
  OPEN_TUI_RENDERER_VALUE,
  TUI_RENDERER_ENV_VAR,
  TUI_RENDERER_STRICT_ENV_VAR,
  type RuntimeVersionProbe,
} from '../../utils/tui-runtime.js';

export {
  compareVersions,
  isOpenTuiRuntimeSupported,
  OPEN_TUI_RENDERER_VALUE,
  parseVersion,
  TUI_RENDERER_ENV_VAR,
  TUI_RENDERER_STRICT_ENV_VAR,
} from '../../utils/tui-runtime.js';
export type { RuntimeVersionProbe } from '../../utils/tui-runtime.js';

/**
 * Renderer selection for the OpenTUI migration (Batch 6).
 *
 * This decides whether the interactive entry mounts OpenTUI or the ink tree.
 * The npm startup handoff reads the same explicit request before relaunching
 * a supported installation into its private Bun runtime. This gate is
 * deliberately dependency-free — it must NOT import `@opentui/*` or any
 * renderer module, because it runs on every interactive startup (including on
 * runtimes where OpenTUI cannot load) and before the renderer of record is
 * chosen. The actual `createCliRenderer` probe lives in the entry, which can
 * fall back to ink if construction throws even when this gate said "opentui".
 *
 * The default renderer stays ink until OpenTUI is both requested and supported.
 */

export type TuiRendererChoice = 'ink' | 'opentui';

export interface RendererSelection {
  renderer: TuiRendererChoice;
  /** Human-readable reason, for debug logging. Never shown to the user. */
  reason: string;
  /**
   * Whether QWEN_TUI_RENDERER_STRICT forbids ink fallbacks after the probe
   * too: the dispatcher consults this when the OpenTUI entry fails to boot
   * and re-throws instead of serving ink.
   */
  strict: boolean;
}

/**
 * Chooses the renderer for an interactive session.
 *
 * The decision is intentionally conservative: OpenTUI is selected only when
 * the flag explicitly requests it AND the runtime can support it. Any other
 * combination — unset flag, an unrecognized value, or an unsupported runtime —
 * keeps ink, which remains the default renderer throughout the migration.
 *
 * The one exception is {@link TUI_RENDERER_STRICT_ENV_VAR}: set by the E2E
 * renderer matrix, it turns the unsupported-runtime ink fallback into a throw
 * so a matrix leg cannot pass while a fallback secretly served ink. This
 * function is called before the dispatcher's own try/catch, so the throw
 * surfaces as a loud startup failure. The flag also survives into
 * {@link RendererSelection.strict} so the dispatcher can block the
 * boot-failure fallback the same way.
 *
 * Screen-reader mode is a second ink-only capability: it needs plain-text
 * append-only output on the main screen with no mouse, and the OpenTUI side
 * has no renderer path for it yet. Serving OpenTUI there would hand a
 * screen-reader user in-place differential redraws, which are worse than
 * useless, so the gate keeps ink.
 */
export function selectTuiRenderer(
  envValue: string | undefined = process.env[TUI_RENDERER_ENV_VAR],
  probe?: RuntimeVersionProbe,
  env: NodeJS.ProcessEnv = process.env,
  screenReader = false,
): RendererSelection {
  const requested = envValue?.trim().toLowerCase();
  const strictValue = env[TUI_RENDERER_STRICT_ENV_VAR]?.trim().toLowerCase();
  const strict = strictValue === '1' || strictValue === 'true';
  if (requested !== OPEN_TUI_RENDERER_VALUE) {
    return {
      renderer: 'ink',
      reason: requested
        ? `${TUI_RENDERER_ENV_VAR}=${envValue} is not "${OPEN_TUI_RENDERER_VALUE}"`
        : `${TUI_RENDERER_ENV_VAR} is not set`,
      strict,
    };
  }
  if (screenReader) {
    if (strict) {
      throw new Error(
        `${TUI_RENDERER_ENV_VAR}=${OPEN_TUI_RENDERER_VALUE} was requested, but screen-reader mode is only implemented by the ink renderer and ` +
          `${TUI_RENDERER_STRICT_ENV_VAR} forbids the silent ink fallback`,
      );
    }
    return {
      renderer: 'ink',
      reason:
        'OpenTUI requested but screen-reader mode is only implemented by the ink renderer',
      strict,
    };
  }
  if (!isOpenTuiRuntimeSupported(probe)) {
    if (strict) {
      throw new Error(
        `${TUI_RENDERER_ENV_VAR}=${OPEN_TUI_RENDERER_VALUE} was requested, but this runtime cannot initialize the OpenTUI native FFI ` +
          `(needs Bun >= ${MIN_BUN_VERSION}) and ` +
          `${TUI_RENDERER_STRICT_ENV_VAR} forbids the silent ink fallback`,
      );
    }
    return {
      renderer: 'ink',
      reason: `OpenTUI requested but the runtime cannot initialize its native FFI (needs Bun >= ${MIN_BUN_VERSION})`,
      strict,
    };
  }
  return {
    renderer: 'opentui',
    reason: `${TUI_RENDERER_ENV_VAR}=${OPEN_TUI_RENDERER_VALUE} on a supported runtime`,
    strict,
  };
}
