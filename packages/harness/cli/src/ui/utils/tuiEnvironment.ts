/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TuiEnvironmentFlags {
  trueColor?: boolean;
  devScenario?: string;
}

let environmentFlags: TuiEnvironmentFlags = {};

/** Product components resolve their environment flags before the first frame. */
export function configureTuiEnvironment(flags?: TuiEnvironmentFlags): void {
  environmentFlags = flags ?? {};
}

export function getTuiEnvironment(): TuiEnvironmentFlags {
  return environmentFlags;
}
