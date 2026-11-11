/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Variable names a product never lets reach child shells. Core strips them from
 * hook subprocesses unconditionally, so a product cannot lose the guarantee by
 * leaving a setting unset.
 */
let productSensitiveEnvironmentVariableNames: readonly string[] = [];

/** Registers the product's sensitive names; replaces any previous list. */
export function registerSensitiveEnvironmentVariables(
  names: readonly string[],
): void {
  productSensitiveEnvironmentVariableNames = [...names];
}

export function getSensitiveEnvironmentVariables(): readonly string[] {
  return productSensitiveEnvironmentVariableNames;
}
