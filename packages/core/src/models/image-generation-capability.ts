/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function isImageGenerationCapable(model: {
  supportsImageGeneration?: boolean;
  imageOnly?: boolean;
}): boolean {
  return model.supportsImageGeneration === true || model.imageOnly === true;
}
