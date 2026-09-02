/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer selection for the OpenTUI migration (Batch 6).
 *
 * This is the single place that reads `QWEN_TUI_RENDERER` and decides whether
 * the interactive entry mounts the OpenTUI backend or the ink tree. It is
 * deliberately dependency-free — it must NOT import `@opentui/*` or any
 * renderer module, because it runs on every interactive startup (including on
 * runtimes where OpenTUI cannot load) and before the renderer of record is
 * chosen. The actual `createCliRenderer` probe lives in the entry, which can
 * fall back to ink if construction throws even when this gate said "opentui".
 *
 * `QWEN_TUI_RENDERER` is the first reader of the flag: nothing else in the
 * repository references it, so the default renderer stays ink until this gate
 * is both requested and supported.
 */

/** The environment variable that selects the TUI renderer. */
export const TUI_RENDERER_ENV_VAR = 'QWEN_TUI_RENDERER';

/**
 * Turns the unsupported-runtime ink fallback into a hard failure. The silent
 * fallback is the right user-facing behavior, but the renderer-matrix E2E
 * legs need "green run really exercised opentui": with this set, an explicit
 * opentui request on a runtime that cannot load the native renderer throws
 * instead of serving ink. Never set it in product defaults.
 */
export const TUI_RENDERER_STRICT_ENV_VAR = 'QWEN_TUI_RENDERER_STRICT';

/** The only non-default renderer value this gate recognizes. */
export const OPEN_TUI_RENDERER_VALUE = 'opentui';

export type TuiRendererChoice = 'ink' | 'opentui';

export interface RendererSelection {
  renderer: TuiRendererChoice;
  /** Human-readable reason, for debug logging. Never shown to the user. */
  reason: string;
}

/** Minimum runtime versions that can initialize the OpenTUI native FFI. */
const MIN_BUN_VERSION = '1.3.0';
const MIN_NODE_VERSION = '26.4.0';

/**
 * Parses a dotted version string into its numeric segments. Non-numeric or
 * missing segments stop the parse; a leading `v` is tolerated.
 */
export function parseVersion(version: string): number[] {
  const cleaned = version.trim().replace(/^v/i, '');
  const segments: number[] = [];
  for (const part of cleaned.split('.')) {
    // A segment like "3-beta" contributes its leading integer only.
    const match = /^(\d+)/.exec(part);
    if (!match) break;
    segments.push(Number(match[1]));
  }
  return segments;
}

/**
 * Returns -1 when a < b, 0 when equal, 1 when a > b. Numerically equal
 * versions break the tie semver-style: a pre-release sorts below its release
 * (`1.3.0-beta < 1.3.0`), so a floor of `1.3.0` rejects `1.3.0-beta`.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const as = parseVersion(a);
  const bs = parseVersion(b);
  const length = Math.max(as.length, bs.length);
  for (let i = 0; i < length; i++) {
    const left = as[i] ?? 0;
    const right = bs[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  const aPre = a.includes('-');
  const bPre = b.includes('-');
  if (aPre !== bPre) return aPre ? -1 : 1;
  return 0;
}

export interface RuntimeVersionProbe {
  /** e.g. "1.3.14" when running under Bun, otherwise undefined. */
  bun?: string;
  /** e.g. "26.4.0" when running under Node, otherwise undefined. */
  node?: string;
}

/**
 * Whether the current runtime can initialize the OpenTUI native FFI. Bun >=
 * 1.3.0 and Node >= 26.4.0 (with `--experimental-ffi`) are the supported
 * floors; anything older returns false so the entry stays on ink.
 */
export function isOpenTuiRuntimeSupported(
  probe: RuntimeVersionProbe = {
    bun: process.versions['bun'],
    node: process.versions['node'],
  },
): boolean {
  if (probe.bun) {
    return compareVersions(probe.bun, MIN_BUN_VERSION) >= 0;
  }
  if (probe.node) {
    return compareVersions(probe.node, MIN_NODE_VERSION) >= 0;
  }
  return false;
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
 * surfaces as a loud startup failure.
 */
export function selectTuiRenderer(
  envValue: string | undefined = process.env[TUI_RENDERER_ENV_VAR],
  probe?: RuntimeVersionProbe,
  env: NodeJS.ProcessEnv = process.env,
): RendererSelection {
  const requested = envValue?.trim().toLowerCase();
  if (requested !== OPEN_TUI_RENDERER_VALUE) {
    return {
      renderer: 'ink',
      reason: requested
        ? `${TUI_RENDERER_ENV_VAR}=${envValue} is not "${OPEN_TUI_RENDERER_VALUE}"`
        : `${TUI_RENDERER_ENV_VAR} is not set`,
    };
  }
  if (!isOpenTuiRuntimeSupported(probe)) {
    const strict = env[TUI_RENDERER_STRICT_ENV_VAR]?.trim().toLowerCase();
    if (strict === '1' || strict === 'true') {
      throw new Error(
        `${TUI_RENDERER_ENV_VAR}=${OPEN_TUI_RENDERER_VALUE} was requested, but this runtime cannot initialize the OpenTUI native FFI ` +
          `(needs Bun >= ${MIN_BUN_VERSION} or Node >= ${MIN_NODE_VERSION}) and ` +
          `${TUI_RENDERER_STRICT_ENV_VAR} forbids the silent ink fallback`,
      );
    }
    return {
      renderer: 'ink',
      reason: `OpenTUI requested but the runtime cannot initialize its native FFI (needs Bun >= ${MIN_BUN_VERSION} or Node >= ${MIN_NODE_VERSION})`,
    };
  }
  return {
    renderer: 'opentui',
    reason: `${TUI_RENDERER_ENV_VAR}=${OPEN_TUI_RENDERER_VALUE} on a supported runtime`,
  };
}
