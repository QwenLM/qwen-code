/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const VISION_BRIDGE_MAX_IMAGES = 4;

/**
 * Conservative cap on a single image part's base64 payload before the vision
 * bridge refuses it. Measured on the inline base64 string, which is what ACP
 * transports over the wire.
 */
export const VISION_BRIDGE_MAX_IMAGE_BASE64_BYTES = Math.floor(
  9.9 * 1024 * 1024,
);
