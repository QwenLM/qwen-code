/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '@qwen-code/qwen-code-core/debugLogger';

// Keep this module light on purpose: daemon-update.ts imports it statically
// from its enabled() gate path, so a core ROOT import would execute the whole
// core module graph on every fresh load of the route module (and once per
// vi.resetModules() cycle in tests). The ./debugLogger subpath pulls only the
// logger. Warnings are gated behind QWEN_DEBUG_LOG_FILE, which also keeps the
// daemon's repeated loadSettings() calls silent unless debugging is on.

const debugLogger = createDebugLogger('UPDATE_MODE');

/**
 * Tri-state replacement for the legacy `general.enableAutoUpdate` boolean
 * (#14274): 'auto' checks and installs, 'notify' checks and only notifies,
 * 'off' skips the startup check entirely.
 */
export type UpdateMode = 'auto' | 'notify' | 'off';

export const UPDATE_MODES: readonly UpdateMode[] = ['auto', 'notify', 'off'];

export function isUpdateMode(value: unknown): value is UpdateMode {
  return (
    typeof value === 'string' &&
    (UPDATE_MODES as readonly string[]).includes(value)
  );
}

interface UpdateModeGeneralSection {
  updateMode?: unknown;
  enableAutoUpdate?: unknown;
}

/**
 * Resolves the effective update mode from a `general` settings section.
 *
 * Precedence:
 * 1. An explicit valid `general.updateMode` wins.
 * 2. An invalid `updateMode` warns and falls through to the legacy key.
 * 3. Legacy `general.enableAutoUpdate`: `false` maps to 'off' (the cohort
 *    that opted into silence keeps it), any other value maps to 'auto'.
 *
 * Invalid values are corrected in place by normalizeUpdateModeInPlace at
 * load time, so this warning fires once per settings load in practice.
 */
export function resolveUpdateMode(
  general?: UpdateModeGeneralSection,
): UpdateMode {
  const explicit = general?.updateMode;
  if (explicit !== undefined) {
    if (isUpdateMode(explicit)) {
      return explicit;
    }
    debugLogger.warn(
      `Invalid general.updateMode value ${JSON.stringify(explicit)}; falling back to general.enableAutoUpdate.`,
    );
  }
  if (general?.enableAutoUpdate === false) {
    return 'off';
  }
  return 'auto';
}

/**
 * Normalizes a loaded settings scope in place so `general.updateMode` holds
 * the resolved value while a legacy `enableAutoUpdate` key is still on disk.
 * Valid explicit values are left untouched, and scopes that set neither key
 * are left untouched too — injecting the 'auto' default here would make the
 * scope look user-modified to per-scope value reporting. The settings file
 * itself is never rewritten by this (unlike version migrations); the legacy
 * key stays on disk until a follow-up migration physically removes it.
 */
export function normalizeUpdateModeInPlace(
  settings: { general?: UpdateModeGeneralSection } | undefined | null,
): void {
  const general = settings?.general;
  if (!general || isUpdateMode(general.updateMode)) {
    return;
  }
  if (
    general.updateMode === undefined &&
    general.enableAutoUpdate === undefined
  ) {
    return;
  }
  general.updateMode = resolveUpdateMode(general);
}
