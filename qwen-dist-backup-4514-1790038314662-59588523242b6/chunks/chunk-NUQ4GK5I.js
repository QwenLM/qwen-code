// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/services/compactionInputSlimming.ts
init_esbuild_shims();
var DEFAULT_IMAGE_TOKEN_ESTIMATE = 1600;
var TOKEN_TO_CHAR_RATIO = 4;
var DEFAULT_MIME = "application/octet-stream";
function sanitizeMimeForPlaceholder(mime) {
  return mime.replace(/[\r\n\t]+/g, " ").replace(/[[\]]/g, "").trim().slice(0, 128);
}
__name(sanitizeMimeForPlaceholder, "sanitizeMimeForPlaceholder");
var imagePlaceholder = /* @__PURE__ */ __name((mime) => `[image: ${sanitizeMimeForPlaceholder(mime)}]`, "imagePlaceholder");
var documentPlaceholder = /* @__PURE__ */ __name((mime) => `[document: ${sanitizeMimeForPlaceholder(mime)}]`, "documentPlaceholder");
function resolveSlimmingConfig(settings) {
  return {
    imageTokenEstimate: resolveNumber(
      process.env["QWEN_IMAGE_TOKEN_ESTIMATE"],
      settings?.imageTokenEstimate,
      DEFAULT_IMAGE_TOKEN_ESTIMATE,
      { minInclusive: 1 }
    )
  };
}
__name(resolveSlimmingConfig, "resolveSlimmingConfig");
function resolveNumber(envValue, settingsValue, defaultValue, {
  integer = false,
  minInclusive
}) {
  const isValid = /* @__PURE__ */ __name((value) => Number.isFinite(value) && (!integer || Number.isSafeInteger(value)) && value >= minInclusive, "isValid");
  if (envValue !== void 0 && envValue !== "") {
    const trimmed = envValue.trim();
    if (integer && !/^\d+$/.test(trimmed)) {
      return settingsValue !== void 0 && isValid(settingsValue) ? settingsValue : defaultValue;
    }
    const parsed = Number(trimmed);
    if (isValid(parsed)) {
      return parsed;
    }
  }
  if (settingsValue !== void 0 && isValid(settingsValue)) {
    return settingsValue;
  }
  return defaultValue;
}
__name(resolveNumber, "resolveNumber");
var DEFAULT_MAX_RECENT_FILES = 5;
var DEFAULT_MAX_RECENT_IMAGES = 3;
var DEFAULT_SCREENSHOT_TRIGGER_ENABLED = true;
var DEFAULT_SCREENSHOT_TRIGGER_THRESHOLD = 20;
var DEFAULT_IMAGE_PAYLOAD_THRESHOLD = 20;
function resolveCompactionTuning(settings) {
  return {
    maxRecentFiles: resolveNumber(
      process.env["QWEN_COMPACT_MAX_RECENT_FILES"],
      settings?.maxRecentFilesToRetain,
      DEFAULT_MAX_RECENT_FILES,
      { integer: true, minInclusive: 0 }
    ),
    maxRecentImages: resolveNumber(
      process.env["QWEN_COMPACT_MAX_RECENT_IMAGES"],
      settings?.maxRecentImagesToRetain,
      DEFAULT_MAX_RECENT_IMAGES,
      { integer: true, minInclusive: 0 }
    ),
    enableScreenshotTrigger: resolveBoolean(
      process.env["QWEN_COMPACT_SCREENSHOT_TRIGGER"],
      settings?.enableScreenshotTrigger,
      DEFAULT_SCREENSHOT_TRIGGER_ENABLED
    ),
    screenshotTriggerThreshold: resolveNumber(
      process.env["QWEN_COMPACT_SCREENSHOT_THRESHOLD"],
      settings?.screenshotTriggerThreshold,
      DEFAULT_SCREENSHOT_TRIGGER_THRESHOLD,
      { integer: true, minInclusive: 1 }
    ),
    imagePayloadThreshold: resolveNumber(
      process.env["QWEN_IMAGE_PAYLOAD_THRESHOLD"],
      settings?.imagePayloadThreshold,
      DEFAULT_IMAGE_PAYLOAD_THRESHOLD,
      { integer: true, minInclusive: 1 }
    )
  };
}
__name(resolveCompactionTuning, "resolveCompactionTuning");
function resolveBoolean(envValue, settingsValue, defaultValue) {
  if (envValue === "1" || envValue === "true") return true;
  if (envValue === "0" || envValue === "false") return false;
  if (typeof settingsValue === "boolean") return settingsValue;
  return defaultValue;
}
__name(resolveBoolean, "resolveBoolean");
function estimatePartChars(part, imageTokenEstimate) {
  if (part.inlineData || part.fileData) {
    return imageTokenEstimate * TOKEN_TO_CHAR_RATIO;
  }
  if (typeof part.text === "string") {
    return part.text.length;
  }
  if (part.functionResponse) {
    let total = 0;
    const output = part.functionResponse.response?.["output"];
    const error = part.functionResponse.response?.["error"];
    if (typeof output === "string") {
      total += output.length;
    } else if (typeof error === "string") {
      total += error.length;
    }
    const nested = getFunctionResponseParts(part);
    if (nested) {
      for (const inner of nested) {
        total += estimatePartChars(inner, imageTokenEstimate);
      }
    }
    return total + 64;
  }
  return JSON.stringify(part ?? {}).length;
}
__name(estimatePartChars, "estimatePartChars");
function getFunctionResponseParts(part) {
  const fr = part.functionResponse;
  return Array.isArray(fr?.parts) ? fr.parts : void 0;
}
__name(getFunctionResponseParts, "getFunctionResponseParts");
function estimateContentChars(content, imageTokenEstimate) {
  if (!content.parts) return 0;
  let total = 0;
  for (const part of content.parts) {
    total += estimatePartChars(part, imageTokenEstimate);
  }
  return total;
}
__name(estimateContentChars, "estimateContentChars");
var SLIM_TEXT_TRUNCATION_MARKER = "\n[...truncated for compaction]";
function slimCompactionInput(history, supportedModalities, options) {
  const stats = {
    imagesStripped: 0,
    documentsStripped: 0,
    textPartsTruncated: 0
  };
  let anyChange = false;
  const slimmed = history.map((content) => {
    if (!content.parts || content.parts.length === 0) return content;
    let touched = false;
    const newParts = content.parts.map((part) => {
      const replacement = transformPart(
        part,
        stats,
        supportedModalities,
        options
      );
      if (replacement !== part) {
        touched = true;
        return replacement;
      }
      return part;
    });
    if (!touched) return content;
    anyChange = true;
    return { ...content, parts: newParts };
  });
  return {
    slimmedHistory: anyChange ? slimmed : history,
    stats
  };
}
__name(slimCompactionInput, "slimCompactionInput");
function transformPart(part, stats, supportedModalities, options) {
  if (part.inlineData) {
    if (supportsMimeType(part.inlineData.mimeType, supportedModalities) === true) {
      return part;
    }
    return mediaPlaceholderPart(part.inlineData.mimeType, stats);
  }
  if (part.fileData) {
    if (supportsMimeType(part.fileData.mimeType, supportedModalities) === true) {
      return part;
    }
    return mediaPlaceholderPart(part.fileData.mimeType, stats);
  }
  let nextPart = part;
  const nested = getFunctionResponseParts(part);
  if (nested) {
    let touched = false;
    const newNested = nested.map((inner) => {
      const replacement = transformPart(
        inner,
        stats,
        supportedModalities,
        options
      );
      if (replacement !== inner) {
        touched = true;
      }
      return replacement;
    });
    if (touched) {
      nextPart = {
        ...part,
        functionResponse: {
          ...part.functionResponse,
          parts: newNested
        }
      };
    }
  }
  const maxTextChars = options?.maxTextChars;
  const fr = nextPart.functionResponse;
  if (maxTextChars !== void 0 && fr?.response) {
    const response = fr.response;
    let touched = false;
    const newResponse = { ...response };
    for (const key of ["output", "error"]) {
      const value = response[key];
      if (typeof value === "string" && value.length > maxTextChars) {
        newResponse[key] = truncateTextForSlimming(value, maxTextChars);
        stats.textPartsTruncated++;
        touched = true;
      }
    }
    if (touched) {
      nextPart = {
        ...nextPart,
        functionResponse: {
          ...fr,
          response: newResponse
        }
      };
    }
  }
  const fc = nextPart.functionCall;
  if (maxTextChars !== void 0 && fc?.args) {
    const args = fc.args;
    let argsTouched = false;
    const newArgs = { ...args };
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" && value.length > maxTextChars) {
        newArgs[key] = truncateTextForSlimming(value, maxTextChars);
        stats.textPartsTruncated++;
        argsTouched = true;
      }
    }
    if (argsTouched) {
      nextPart = {
        ...nextPart,
        functionCall: { ...fc, args: newArgs }
      };
    }
  }
  if (maxTextChars !== void 0 && typeof nextPart.text === "string" && nextPart.text.length > maxTextChars) {
    stats.textPartsTruncated++;
    return {
      ...nextPart,
      text: truncateTextForSlimming(nextPart.text, maxTextChars)
    };
  }
  return nextPart;
}
__name(transformPart, "transformPart");
function truncateTextForSlimming(value, maxTextChars) {
  let end = maxTextChars;
  const last = value.charCodeAt(end - 1);
  if (last >= 55296 && last <= 56319) {
    end--;
  }
  return value.slice(0, end) + SLIM_TEXT_TRUNCATION_MARKER;
}
__name(truncateTextForSlimming, "truncateTextForSlimming");
function supportsMimeType(mimeType, modalities) {
  if (!modalities) return void 0;
  const mime = mimeType ?? DEFAULT_MIME;
  if (mime.startsWith("image/")) return modalities.image;
  if (mime === "application/pdf") return modalities.pdf;
  if (mime.startsWith("audio/")) return modalities.audio;
  if (mime.startsWith("video/")) return modalities.video;
  return false;
}
__name(supportsMimeType, "supportsMimeType");
function mediaPlaceholderPart(mimeType, stats) {
  const mime = mimeType ?? DEFAULT_MIME;
  if (isNonImageMime(mime)) {
    stats.documentsStripped++;
    return { text: documentPlaceholder(mime) };
  }
  stats.imagesStripped++;
  return { text: imagePlaceholder(mime) };
}
__name(mediaPlaceholderPart, "mediaPlaceholderPart");
function isNonImageMime(mime) {
  return !mime.startsWith("image/");
}
__name(isNonImageMime, "isNonImageMime");

export {
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  TOKEN_TO_CHAR_RATIO,
  sanitizeMimeForPlaceholder,
  resolveSlimmingConfig,
  resolveCompactionTuning,
  estimatePartChars,
  getFunctionResponseParts,
  estimateContentChars,
  slimCompactionInput
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
