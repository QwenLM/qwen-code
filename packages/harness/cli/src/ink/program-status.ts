/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { BRAND_FIXED_ENV_PREFIX } from '@qwen-code/core';

export const ENV_PROGRAM_STATUS = `${BRAND_FIXED_ENV_PREFIX}PROGRAM_STATUS`;

/**
 * OSC 7501 capability state for this process.
 *
 * Setting the program-status variable to `1` turns reporting on without probing, `0` turns it
 * off. Otherwise App.tsx sends `OSC 7501 ; ?` ahead of the DA1 sentinel when
 * raw mode enables, and a reply arriving first marks the terminal as
 * supported. Until then reporting stays off.
 */

export type ProgramStatusOverride = 'on' | 'off' | undefined;

export function getProgramStatusOverride(
  env: NodeJS.ProcessEnv = process.env,
): ProgramStatusOverride {
  const value = env[ENV_PROGRAM_STATUS];
  if (value === '1') return 'on';
  if (value === '0') return 'off';
  return undefined;
}

/**
 * VTE before 0.53 prints unknown OSC sequences as text, so neither the probe
 * nor reports may be written there.
 */
export function hasUnknownOscPrintingBug(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const vte = env['VTE_VERSION'];
  if (!vte) return false;
  const version = parseInt(vte, 10);
  return Number.isFinite(version) && version < 5300;
}

/** Whether the startup probe should be sent at all. */
export function shouldProbeProgramStatus(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getProgramStatusOverride(env) === undefined && !hasUnknownOscPrintingBug(env);
}

let probeSupported = false;
const listeners = new Set<() => void>();

/** Records a probe reply. Only upgrades: a later re-probe never revokes. */
export function setProgramStatusSupported(): void {
  if (probeSupported) return;
  probeSupported = true;
  for (const listener of listeners) listener();
}

export function isProgramStatusEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const override = getProgramStatusOverride(env);
  if (override !== undefined) return override === 'on';
  return probeSupported;
}

export function subscribeProgramStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a report was written, so exit cleanup knows to send a clear. */
let reported = false;

export function markProgramStatusReported(value: boolean): void {
  reported = value;
}

export function hasReportedProgramStatus(): boolean {
  return reported;
}

export function resetProgramStatusForTesting(): void {
  probeSupported = false;
  reported = false;
  listeners.clear();
}
