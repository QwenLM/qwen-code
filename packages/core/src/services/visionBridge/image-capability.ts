/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vision-bridge capability advertisement for ACP initialize responses.
 *
 * Boolean flags describe backend-handled behavior for ACP hosts; numeric
 * thresholds track the same constants enforced by the vision bridge.
 *
 * Placed in `agentCapabilities._meta.imageCapability` of the ACP
 * `initialize` response on both stdio and HTTP paths.
 */
import {
  VISION_BRIDGE_MAX_IMAGE_BASE64_BYTES,
  VISION_BRIDGE_MAX_IMAGES,
} from './vision-bridge-constants.js';

export const IMAGE_CAPABILITY = Object.freeze({
  /** Text-only active models are handled by the vision bridge when configured. */
  autoHandlesWrongModel: true,
  /** Current per-image inline base64 payload cap, in bytes. */
  maxBytes: VISION_BRIDGE_MAX_IMAGE_BASE64_BYTES,
  /** Current max images processed per turn. */
  maxImagesPerTurn: VISION_BRIDGE_MAX_IMAGES,
});
