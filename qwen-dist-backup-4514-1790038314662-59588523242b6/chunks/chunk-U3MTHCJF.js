// Force strict mode and setup for ESM
"use strict";
import {
  MAX_TERMINAL_IMAGE_BYTES
} from "./chunk-VPGRGNNH.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/utils/inline-image-parts.ts
init_esbuild_shims();
var MAX_INLINE_IMAGES_PER_ITEM = 4;
var MAX_INLINE_IMAGE_ENCODED_LENGTH = Math.ceil(MAX_TERMINAL_IMAGE_BYTES * 4 / 3) + 4;
function formatInlineImageOverflow(count) {
  return `[+${count} more ${count === 1 ? "image" : "images"}]`;
}
__name(formatInlineImageOverflow, "formatInlineImageOverflow");
function getInlineImageData(part) {
  const inlineData = part.inlineData;
  if (!inlineData?.mimeType?.trim().toLowerCase().startsWith("image/") || typeof inlineData.data !== "string" || inlineData.data.length === 0 || inlineData.data.length > MAX_INLINE_IMAGE_ENCODED_LENGTH) {
    return null;
  }
  return {
    data: inlineData.data,
    mimeType: inlineData.mimeType
  };
}
__name(getInlineImageData, "getInlineImageData");
function collectInlineImages(parts) {
  if (!parts) {
    return { images: [], omittedImageCount: 0 };
  }
  const images = [];
  let omittedImageCount = 0;
  const collectImage = /* @__PURE__ */ __name((part) => {
    const image = getInlineImageData(part);
    if (!image) {
      return;
    }
    if (images.length < MAX_INLINE_IMAGES_PER_ITEM) {
      images.push(image);
    } else {
      omittedImageCount++;
    }
  }, "collectImage");
  for (const part of parts) {
    collectImage(part);
    for (const nested of part.functionResponse?.parts ?? []) {
      collectImage(nested);
    }
  }
  return { images, omittedImageCount };
}
__name(collectInlineImages, "collectInlineImages");
function extractInlineContentRuns(parts, textSeparator = "") {
  if (!parts) {
    return [];
  }
  const runs = [];
  let textParts = [];
  let displayedImageCount = 0;
  let overflowRun = null;
  const flushText = /* @__PURE__ */ __name(() => {
    if (textParts.length === 0) return;
    runs.push({ kind: "text", text: textParts.join(textSeparator) });
    textParts = [];
  }, "flushText");
  for (const part of parts) {
    if (part.thought) continue;
    if (part.text) {
      textParts.push(part.text);
    }
    const image = getInlineImageData(part);
    if (image) {
      flushText();
      if (displayedImageCount < MAX_INLINE_IMAGES_PER_ITEM) {
        runs.push({ kind: "image", image });
        displayedImageCount++;
      } else if (overflowRun) {
        overflowRun.count++;
      } else {
        overflowRun = { kind: "omitted_images", count: 1 };
        runs.push(overflowRun);
      }
    }
  }
  flushText();
  return runs;
}
__name(extractInlineContentRuns, "extractInlineContentRuns");

export {
  MAX_INLINE_IMAGES_PER_ITEM,
  MAX_INLINE_IMAGE_ENCODED_LENGTH,
  formatInlineImageOverflow,
  getInlineImageData,
  collectInlineImages,
  extractInlineContentRuns
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
