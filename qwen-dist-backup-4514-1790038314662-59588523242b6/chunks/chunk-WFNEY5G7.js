// Force strict mode and setup for ESM
"use strict";
import {
  getFunctionResponseParts,
  sanitizeMimeForPlaceholder
} from "./chunk-NUQ4GK5I.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/core/inlineMediaLimit.ts
init_esbuild_shims();
var DEFAULT_MAX_INLINE_MEDIA_BYTES = 10 * 1024 * 1024;
function getMaxInlineMediaBytes() {
  const raw = process.env["QWEN_CODE_MAX_INLINE_MEDIA_BYTES"];
  if (raw === void 0 || raw.trim() === "") {
    return DEFAULT_MAX_INLINE_MEDIA_BYTES;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_INLINE_MEDIA_BYTES;
}
__name(getMaxInlineMediaBytes, "getMaxInlineMediaBytes");
function approxBase64Bytes(base64) {
  let start = 0;
  if (base64.startsWith("data:")) {
    const commaIndex = base64.indexOf(",");
    if (commaIndex !== -1) {
      start = commaIndex + 1;
    }
  }
  const length = base64.length - start;
  if (length === 0) {
    return 0;
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(length * 3 / 4) - padding;
}
__name(approxBase64Bytes, "approxBase64Bytes");
function formatMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}
__name(formatMb, "formatMb");
function oversizedMediaPlaceholder(mimeType, bytes, limitBytes) {
  const mime = sanitizeMimeForPlaceholder(mimeType);
  return `[Media omitted: ${mime} is ~${formatMb(bytes)}MB, exceeding the ${formatMb(limitBytes)}MB inline limit. Ask the user to resize/compress it, or reference it via an @file path so it can be read from disk.]`;
}
__name(oversizedMediaPlaceholder, "oversizedMediaPlaceholder");
function clampInlineMediaPart(part, limitBytes = getMaxInlineMediaBytes()) {
  const data = part.inlineData?.data;
  if (!data) {
    return part;
  }
  const bytes = approxBase64Bytes(data);
  if (bytes <= limitBytes) {
    return part;
  }
  const mimeType = part.inlineData?.mimeType ?? "application/octet-stream";
  return { text: oversizedMediaPlaceholder(mimeType, bytes, limitBytes) };
}
__name(clampInlineMediaPart, "clampInlineMediaPart");

// packages/core/src/core/openaiContentGenerator/prefix-caching.ts
init_esbuild_shims();
var CACHE_KEY_PREFIX = "qwen-code:";
var EXPLICIT_BREAKPOINT_COUNT = 2;
function supportsOpenAIPrefixCaching(contentGeneratorConfig) {
  return contentGeneratorConfig.authType === "openai" /* USE_OPENAI */ || contentGeneratorConfig.authType === "qwen-oauth" /* QWEN_OAUTH */;
}
__name(supportsOpenAIPrefixCaching, "supportsOpenAIPrefixCaching");
function isOfficialOpenAIEndpoint(contentGeneratorConfig) {
  if (contentGeneratorConfig.authType !== "openai" /* USE_OPENAI */) return false;
  const { baseUrl } = contentGeneratorConfig;
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}
__name(isOfficialOpenAIEndpoint, "isOfficialOpenAIEndpoint");
function supportsExplicitOpenAIPromptCaching(model) {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:[-.]|$)/i.exec(model);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || major === 5 && minor >= 6;
}
__name(supportsExplicitOpenAIPromptCaching, "supportsExplicitOpenAIPromptCaching");
function withCacheBreakpoint(message) {
  if (message.role !== "user" && message.role !== "tool") return void 0;
  const marker = { prompt_cache_breakpoint: { mode: "explicit" } };
  if (typeof message.content === "string") {
    return {
      ...message,
      content: [{ type: "text", text: message.content, ...marker }]
    };
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    return void 0;
  }
  const content = [...message.content];
  const lastIndex = content.length - 1;
  content[lastIndex] = { ...content[lastIndex], ...marker };
  return { ...message, content };
}
__name(withCacheBreakpoint, "withCacheBreakpoint");
function applyOfficialOpenAIPromptCaching(request, sessionId, cacheSharing, cacheKeyPartition) {
  const result = { ...request };
  if (sessionId && !result.prompt_cache_key) {
    const partition = cacheKeyPartition ? `:${cacheKeyPartition}` : "";
    result.prompt_cache_key = `${CACHE_KEY_PREFIX}${sessionId}${partition}`;
  }
  if (!cacheSharing || !supportsExplicitOpenAIPromptCaching(request.model)) {
    return result;
  }
  const messages = [...request.messages];
  let marked = 0;
  for (let index = messages.length - 2; index >= 0 && marked < EXPLICIT_BREAKPOINT_COUNT; index -= 1) {
    const message = messages[index];
    const updated = message ? withCacheBreakpoint(message) : void 0;
    if (!updated) continue;
    messages[index] = updated;
    marked += 1;
  }
  if (marked === 0) return result;
  result.messages = messages;
  result.prompt_cache_options = {
    ...result.prompt_cache_options,
    mode: "explicit"
  };
  return result;
}
__name(applyOfficialOpenAIPromptCaching, "applyOfficialOpenAIPromptCaching");

// packages/core/src/services/image-payload-references.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
var IMAGE_ID_LENGTH = 12;
var IMAGE_REFERENCE_PATTERN = new RegExp(
  `\\[Image #([a-f0-9]{${IMAGE_ID_LENGTH}}): [^\\]]+\\]`,
  "gi"
);
var InMemoryImagePayloadStore = class {
  static {
    __name(this, "InMemoryImagePayloadStore");
  }
  images = /* @__PURE__ */ new Map();
  put(part) {
    const stored = imagePartToStoredPayload(part);
    this.images.set(stored.id, stored);
    return stored;
  }
  get(id) {
    return this.images.get(id);
  }
};
function countAllInlineImages(contents) {
  let count = 0;
  for (const _part of inlineImageParts(contents)) count++;
  return count;
}
__name(countAllInlineImages, "countAllInlineImages");
function replaceImagePayloadsInPlace(contents, store, skipContent) {
  const replaced = [];
  for (const part of inlineImageParts(contents, skipContent)) {
    const stored = store.put(part);
    replaced.push(stored);
    part.text = imageReferenceText(stored);
    delete part.inlineData;
  }
  return replaced;
}
__name(replaceImagePayloadsInPlace, "replaceImagePayloadsInPlace");
function buildReattachParts(replaced, maxRecentImages, referencedContents = [], store) {
  const referencedIds = collectReferencedImageIds(referencedContents);
  if (replaced.length === 0 && (!store || referencedIds.size === 0)) return [];
  const inlineIds = collectInlineImageIds(referencedContents);
  const last = referencedContents.at(-1);
  const lastReferencedIds = collectReferencedImageIds(
    last?.role === "user" ? [last] : []
  );
  const candidates = replaced.filter(
    (image) => !inlineIds.has(image.id) && !lastReferencedIds.has(image.id)
  ).map((stored) => ({ stored }));
  if (store) {
    for (const id of referencedIds) {
      if (inlineIds.has(id) || lastReferencedIds.has(id)) continue;
      const stored = store.get(id);
      if (stored) candidates.push({ stored });
    }
  }
  const recent = recentUniqueImages(candidates, maxRecentImages).map(
    ({ stored }) => stored
  );
  const reattachLimit = Math.max(maxRecentImages, 1);
  if (store) {
    for (const id of lastReferencedIds) {
      if (inlineIds.has(id) || recent.some((image) => image.id === id)) {
        continue;
      }
      const stored = store.get(id);
      if (stored) {
        if (recent.length >= reattachLimit) recent.shift();
        recent.push(stored);
      }
    }
  }
  if (recent.length === 0) return [];
  return [
    {
      text: reattachContextText(recent.map((img) => img.id)),
      partMetadata: { [REATTACH_BOUNDARY_METADATA]: true }
    },
    ...recent.map(storedImageToPart)
  ];
}
__name(buildReattachParts, "buildReattachParts");
var REATTACH_BOUNDARY_METADATA = "qwen-code:reattach-boundary";
function trailingReattachPartCount(contents) {
  const last = Array.isArray(contents) ? contents.at(-1) : void 0;
  const parts = last && typeof last === "object" && "parts" in last ? last.parts : void 0;
  if (!Array.isArray(parts) || parts.length === 0) return 0;
  const firstMarked = parts.findIndex(
    (part) => typeof part === "object" && part !== null && part.partMetadata?.[REATTACH_BOUNDARY_METADATA] === true
  );
  if (firstMarked === -1) return 0;
  return parts.length - firstMarked;
}
__name(trailingReattachPartCount, "trailingReattachPartCount");
function collectInlineImageIds(contents) {
  const ids = /* @__PURE__ */ new Set();
  for (const part of inlineImageParts(contents)) {
    ids.add(imagePartToStoredPayload(part).id);
  }
  return ids;
}
__name(collectInlineImageIds, "collectInlineImageIds");
function* inlineImageParts(contents, skipContent) {
  for (const content of contents) {
    if (content === skipContent) continue;
    for (const part of content.parts ?? []) {
      if (part.inlineData?.mimeType?.startsWith("image/") && part.inlineData.data) {
        yield part;
      }
      for (const inner of getFunctionResponseParts(part) ?? []) {
        if (inner.inlineData?.mimeType?.startsWith("image/") && inner.inlineData.data) {
          yield inner;
        }
      }
    }
  }
}
__name(inlineImageParts, "inlineImageParts");
function collectReferencedImageIds(contents) {
  const ids = /* @__PURE__ */ new Set();
  const collect = /* @__PURE__ */ __name((parts) => {
    for (const part of parts ?? []) {
      for (const match of part.text?.matchAll(IMAGE_REFERENCE_PATTERN) ?? []) {
        const id = match[1];
        if (id) ids.add(id.toLowerCase());
      }
      collect(getFunctionResponseParts(part));
    }
  }, "collect");
  for (const content of contents) {
    collect(content.parts);
  }
  return ids;
}
__name(collectReferencedImageIds, "collectReferencedImageIds");
function recentUniqueImages(collected, maxRecentImages) {
  if (maxRecentImages <= 0) {
    return [];
  }
  const recent = [];
  const seen = /* @__PURE__ */ new Set();
  for (let index = collected.length - 1; index >= 0; index--) {
    const image = collected[index];
    if (!image || seen.has(image.stored.id)) continue;
    seen.add(image.stored.id);
    recent.push(image);
    if (recent.length === maxRecentImages) break;
  }
  return recent.reverse();
}
__name(recentUniqueImages, "recentUniqueImages");
function imagePartToStoredPayload(part) {
  const data = part.inlineData?.data ?? "";
  const mimeType = part.inlineData?.mimeType ?? "application/octet-stream";
  const hash = createHash("sha256").update(mimeType).update("\0").update(data).digest("hex");
  return {
    id: hash.slice(0, IMAGE_ID_LENGTH),
    mimeType,
    data,
    bytes: approxBase64Bytes(data),
    displayName: part.inlineData?.displayName
  };
}
__name(imagePartToStoredPayload, "imagePartToStoredPayload");
function imageReferenceText(stored) {
  return `[Image #${stored.id}: ${safeImageMimeType(stored.mimeType)}, ${stored.bytes} bytes]`;
}
__name(imageReferenceText, "imageReferenceText");
function reattachContextText(ids) {
  return "Images read earlier in this session (may be OUTDATED, do not treat as current UI state): " + ids.map((id) => `Image #${id}`).join(", ");
}
__name(reattachContextText, "reattachContextText");
function safeImageMimeType(mimeType) {
  return /^image\/[a-z0-9.+-]{1,64}$/i.test(mimeType) ? mimeType.toLowerCase() : "image/unknown";
}
__name(safeImageMimeType, "safeImageMimeType");
function storedImageToPart(stored) {
  return {
    inlineData: {
      mimeType: stored.mimeType,
      data: stored.data,
      displayName: stored.displayName
    }
  };
}
__name(storedImageToPart, "storedImageToPart");

export {
  supportsOpenAIPrefixCaching,
  isOfficialOpenAIEndpoint,
  applyOfficialOpenAIPromptCaching,
  approxBase64Bytes,
  clampInlineMediaPart,
  InMemoryImagePayloadStore,
  countAllInlineImages,
  replaceImagePayloadsInPlace,
  buildReattachParts,
  trailingReattachPartCount
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
