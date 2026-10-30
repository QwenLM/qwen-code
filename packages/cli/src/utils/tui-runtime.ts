/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** The environment variable that selects the TUI renderer. */
export const TUI_RENDERER_ENV_VAR = 'QWEN_TUI_RENDERER';

/**
 * Turns the ink fallback into a hard failure. The silent fallback is the
 * right user-facing behavior, but the renderer-matrix E2E legs need "green
 * run really exercised opentui": with this set, an explicit opentui request
 * that cannot be served — the runtime cannot load the native renderer, or
 * the OpenTUI entry fails to boot — throws instead of serving ink. Never set
 * it in product defaults.
 */
export const TUI_RENDERER_STRICT_ENV_VAR = 'QWEN_TUI_RENDERER_STRICT';

/** The only non-default renderer value this gate recognizes. */
export const OPEN_TUI_RENDERER_VALUE = 'opentui';

/** Minimum Bun version supported by the OpenTUI runtime. */
export const MIN_BUN_VERSION = '1.3.0';

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
 * Whether the current runtime supports OpenTUI. Node launches must hand off
 * to Bun; otherwise the entry stays on ink.
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
  return false;
}
