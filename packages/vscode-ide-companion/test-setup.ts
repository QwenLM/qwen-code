/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Model limits and modalities come from the regex tables unless a test opts
// into the models.dev catalog. Without this default, assertions that resolve
// limits through core (e.g. acpModelInfo's knownTokenLimit) read whatever
// ~/.qwen/model-registry.json the host happens to hold.
if (process.env['QWEN_CODE_MODELS_DEV'] === undefined) {
  process.env['QWEN_CODE_MODELS_DEV'] = 'off';
}
