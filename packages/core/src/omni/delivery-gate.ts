/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Leaf module for the omni delivery activation check, split out of
 * `omni/index.ts` so lightweight consumers (system-prompt assembly in
 * client.ts, media-guidance.ts) can evaluate the gate without statically
 * pulling in the whole delivery pipeline (storage, upload, ffmpeg,
 * policy orchestrator).
 */

import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { getEffectiveOmniUploadConfig } from './upload-config.js';

const debugLogger = createDebugLogger('omni:delivery-gate');

/**
 * Gate for the omni delivery path. All conditions must hold:
 *
 * 1. omni enabled (settings or QWEN_CODE_ENABLE_OMNI=1);
 * 2. trusted workspace (the pipeline writes .qwen/omni/ and uploads
 *    workspace bytes off-machine);
 * 3. a resolved upload channel: an explicitly separated DashScope one, a
 *    self-hosted bucket from `OMNI_OSS_*`, or the legacy static DashScope
 *    inference configuration.
 *
 * Any failed condition falls back to the pre-omni inline behavior.
 * Modality support is checked by the caller (fileUtils) alongside the
 * existing modality gate.
 */
export function isOmniDeliveryActive(config: Config): boolean {
  // Optional calls so stub Configs in tests (and embedders constructing
  // partial configs) don't need the omni accessors to process files.
  if (!config.isOmniEnabled?.()) return false;
  if (config.isTrustedFolder?.() === false) {
    debugLogger.debug('omni delivery inactive: untrusted workspace');
    return false;
  }
  if (!getEffectiveOmniUploadConfig(config)) {
    debugLogger.debug(
      'omni delivery inactive: no usable DashScope upload configuration',
    );
    return false;
  }
  return true;
}
