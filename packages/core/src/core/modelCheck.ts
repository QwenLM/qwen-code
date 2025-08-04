/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// 移除未使用的导入

/**
 * Checks if the default "pro" model is rate-limited and returns a fallback "flash"
 * model if necessary. This function is designed to be silent.
 * @param apiKey The API key to use for the check.
 * @param currentConfiguredModel The model currently configured in settings.
 * @returns An object indicating the model to use, whether a switch occurred,
 *          and the original model if a switch happened.
 */
export async function getEffectiveModel(
  _apiKey: string,
  currentConfiguredModel: string,
  _proxy: string | undefined,
): Promise<string> {
  // Disable Google API Model Check
  return currentConfiguredModel;
}
