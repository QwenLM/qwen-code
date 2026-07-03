/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vision-bridge capability advertisement for ACP initialize responses.
 *
 * Describes BEHAVIOR (boolean flags), not internal constants, so external
 * consumers like sudowork can feature-detect without coupling to thresholds
 * that may change across releases.
 *
 * Placed in `agentCapabilities._meta.imageCapability` of the ACP
 * `initialize` response on both stdio and HTTP paths.
 */
export const IMAGE_CAPABILITY = Object.freeze({
  /** Main model lacks vision → auto-route to same-provider vision model. */
  autoRoutesToVisionBridge: true,
  /** Images exceeding the size limit are silently dropped. */
  capsImageSize: true,
  /** Informational — max images processed per turn (mirrors VISION_BRIDGE_MAX_IMAGES). */
  maxImagesPerTurn: 4,
});
