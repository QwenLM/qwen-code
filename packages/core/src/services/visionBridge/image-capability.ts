/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vision-bridge capability advertisement for ACP initialize responses.
 *
 * Boolean flags describe stable behavior; `maxImagesPerTurn` is an
 * informational threshold that tracks the internal `VISION_BRIDGE_MAX_IMAGES`
 * constant.
 *
 * Placed in `agentCapabilities._meta.imageCapability` of the ACP
 * `initialize` response on both stdio and HTTP paths.
 */
import { VISION_BRIDGE_MAX_IMAGES } from './vision-bridge-constants.js';

export const IMAGE_CAPABILITY = Object.freeze({
  /** Auto-routing is supported when a same-provider vision model is available. */
  autoRoutesToVisionBridge: true,
  /** Images exceeding the size limit are dropped and counted in omittedCount. */
  capsImageSize: true,
  /** Informational — max images processed per turn (mirrors VISION_BRIDGE_MAX_IMAGES). */
  maxImagesPerTurn: VISION_BRIDGE_MAX_IMAGES,
});
