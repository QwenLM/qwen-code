/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Translates between PermissionMode/PlanStateManager and the SDK wire format used in
 * `external_metadata.permission_mode` / `available_permission_modes`.
 *
 * Core permission-mode values map directly. The legacy `plan` wire value maps
 * to independent PlanStateManager state and never reaches Config.setPermissionMode.
 */

import {
  ENV_RUNNING_ENV,
  isPlanStateBlockedByMode,
  PLAN_MODE_BLOCKED_MESSAGE,
  type Config,
  type PermissionMode,
} from '@qwen-code/core';
export type SdkPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'auto';
import { setSdkPlanMode } from '../utils/planModeControlProtocol.js';

/** Wire values that correspond to a real `PermissionMode`. */
const CORE_SDK_MODES = new Set<string>([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
  'auto',
]);

/**
 * Values accepted on the SDK wire.
 *
 * Deliberately not the internal `PermissionMode` union. `bypassPermissions` is
 * what SDK clients have always sent and what they still send; internally that
 * mode is now called `yolo`. The two vocabularies are related by the table below
 * and nothing else — casting one to the other would compile and be wrong.
 *
 * `plan` remains a compatibility value even though it is represented internally
 * by PlanStateManager rather than PermissionMode.
 */
const SDK_WIRE_MODES = new Set<string>([...CORE_SDK_MODES, 'plan']);

/** The one mode whose wire name differs from its internal name. */
const WIRE_TO_INTERNAL: Readonly<Record<string, PermissionMode>> = {
  bypassPermissions: 'yolo',
};
const INTERNAL_TO_WIRE: Readonly<Record<string, SdkPermissionMode>> = {
  yolo: 'bypassPermissions',
};

/**
 * Maps an internal permission-mode id (the vocabulary ACP advertises) to the
 * SDK wire format string. Returns undefined for ids outside both vocabularies,
 * leaving validation to the caller that owns the error surface.
 */
export function permissionModeIdToSdk(
  modeId: string,
): SdkPermissionMode | undefined {
  const wire = INTERNAL_TO_WIRE[modeId] ?? modeId;
  return CORE_SDK_MODES.has(wire) ? (wire as SdkPermissionMode) : undefined;
}

/**
 * Maps a PermissionMode to the SDK wire format string.
 * Falls back to 'default' for modes not supported over the wire.
 */
export function permissionModeToSdk(mode: PermissionMode): SdkPermissionMode {
  return permissionModeIdToSdk(mode) ?? 'default';
}

/**
 * Maps a remote/SDK permission mode string back to a PermissionMode value.
 * Returns undefined for unrecognized values.
 */
export function mapSdkPermissionMode(
  value: unknown,
): PermissionMode | undefined {
  if (typeof value !== 'string') return undefined;
  if (!CORE_SDK_MODES.has(value)) return undefined;
  return WIRE_TO_INTERNAL[value] ?? (value as PermissionMode);
}

/** Parse a compatibility value from the SDK wire, including `plan`. */
export function parseSdkPermissionMode(
  value: unknown,
): SdkPermissionMode | undefined {
  if (typeof value !== 'string') return undefined;
  return SDK_WIRE_MODES.has(value) ? (value as SdkPermissionMode) : undefined;
}

/**
 * Whether raw user input (--permission-mode, settings, agent frontmatter) asks
 * for plan. Plan is not a permission mode — it is an independent work state
 * owned by PlanStateManager — but users write it in the same field, so the
 * request has to be recognised here and routed to the plan domain.
 */
export function isPlanModeRequest(value: string | undefined): boolean {
  if (!value) return false;
  return value.toLowerCase().replace(/[^a-z0-9]/g, '') === 'plan';
}

/** Return the current SDK-visible mode, projecting independent plan state. */
export function getSdkPermissionMode(config: Config): SdkPermissionMode {
  return config.planStateManager?.isActive === true
    ? 'plan'
    : permissionModeToSdk(config.getPermissionMode());
}

/**
 * Apply an SDK wire mode to the internal permission-mode/plan-state model.
 *
 * Returns the core permission mode when one was applied. `plan` returns
 * undefined because entering plan does not change Config.permissionMode.
 */
export function applySdkPermissionMode(
  config: Config,
  mode: SdkPermissionMode,
): PermissionMode | undefined {
  if (mode === 'plan') {
    setSdkPlanMode(config, true);
    return undefined;
  }

  const permissionMode = mapSdkPermissionMode(mode);
  if (permissionMode === undefined) {
    throw new Error(`unknown permission_mode: ${mode}`);
  }

  // Validate and apply the core mode before leaving plan. setPermissionMode
  // may reject privileged modes; keeping plan active until it succeeds avoids
  // a half-applied transition on failure.
  const wasPlanActive = config.planStateManager?.isActive === true;
  config.setPermissionMode(permissionMode, { trigger: 'remote' });
  if (wasPlanActive && config.planStateManager.isActive) {
    setSdkPlanMode(config, false);
  }
  return permissionMode;
}

/**
 * Apply a permission-only transition for the new independent Plan contract.
 * Legacy callers must continue to use applySdkPermissionMode().
 */
export function applyIndependentPermissionMode(
  config: Config,
  mode: SdkPermissionMode,
): PermissionMode {
  const permissionMode = mapSdkPermissionMode(mode);
  if (permissionMode === undefined) {
    throw new Error(`unknown permission_mode: ${mode}`);
  }
  if (
    config.planStateManager.isActive &&
    isPlanStateBlockedByMode(permissionMode)
  ) {
    throw new Error(PLAN_MODE_BLOCKED_MESSAGE);
  }
  config.setPermissionMode(permissionMode, { trigger: 'remote' });
  return permissionMode;
}

/** Enter or exit independent Plan state without changing Permission. */
export function applyIndependentPlanMode(
  config: Config,
  active: boolean,
): void {
  setSdkPlanMode(config, active);
}

/**
 * Validate a creation-time Permission + Plan pair before applying either
 * field, so invalid combinations do not leave a half-applied state.
 */
export function applyIndependentSessionMode(
  config: Config,
  input: { permissionMode?: unknown; planMode?: unknown },
): void {
  const hasPermissionMode = input.permissionMode !== undefined;
  const hasPlanMode = input.planMode !== undefined;
  let permissionMode: PermissionMode | undefined;
  let planMode: boolean | undefined;

  if (hasPermissionMode) {
    permissionMode = mapSdkPermissionMode(input.permissionMode);
    if (permissionMode === undefined) {
      throw new Error(`unknown permission_mode: ${String(input.permissionMode)}`);
    }
  }
  if (hasPlanMode) {
    if (typeof input.planMode !== 'boolean') {
      throw new Error('planMode must be a boolean');
    }
    planMode = input.planMode;
  }

  const targetPermissionMode = permissionMode ?? config.getPermissionMode();
  const targetPlanMode = planMode ?? config.planStateManager.isActive;
  if (targetPlanMode) {
    if (!config.isPlanEnabled()) {
      throw new Error('Plan mode is disabled.');
    }
    if (isPlanStateBlockedByMode(targetPermissionMode)) {
      throw new Error(PLAN_MODE_BLOCKED_MESSAGE);
    }
  }

  if (permissionMode !== undefined) {
    config.setPermissionMode(permissionMode, { trigger: 'remote' });
  }
  if (planMode !== undefined) {
    applyIndependentPlanMode(config, planMode);
  }
}

/**
 * Compute the set of permission modes a remote/SDK client may present.
 * This intentionally mirrors the safe user-addressable modes:
 *   default → acceptEdits → auto.
 * In cloud, `bypassPermissions` is additionally advertised before auto.
 *
 * `plan` is deliberately not advertised as a permission mode, but remains
 * accepted on inbound SDK control requests for compatibility.
 */
export function computeAvailablePermissionModes(
  config?: Config,
): SdkPermissionMode[] {
  const modes: SdkPermissionMode[] = [];
  if (process.env[ENV_RUNNING_ENV] === 'cloud') {
    modes.push('bypassPermissions');
  }
  modes.push('default');
  modes.push('acceptEdits');
  modes.push('auto');
  // `config` retained for parity with future gating; plan is an independent
  // state, so it is excluded from the selectable permission-mode list.
  void config;
  return modes;
}

/**
 * Parse an over-the-wire array of permission mode strings. Drops non-string
 * entries and values outside the SDK set. Returns undefined for non-arrays.
 */
export function parseSdkPermissionModeArray(
  value: unknown,
): SdkPermissionMode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: SdkPermissionMode[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && SDK_WIRE_MODES.has(entry)) {
      out.push(entry as SdkPermissionMode);
    }
  }
  return out;
}
