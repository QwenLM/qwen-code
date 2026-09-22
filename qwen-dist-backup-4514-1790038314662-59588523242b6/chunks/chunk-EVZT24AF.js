// Force strict mode and setup for ESM
"use strict";
import {
  resolveNetworkTarget
} from "./chunk-6C3D7BKK.js";
import {
  isPrivateHost
} from "./chunk-KKPIFWTZ.js";
import {
  loadUndici
} from "./chunk-SBP43AO6.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/services/image-generation-service.ts
init_esbuild_shims();
var GENERATION_TIMEOUT_MS = 24e4;
var DOWNLOAD_TIMEOUT_MS = 12e4;
var MAX_API_RESPONSE_BYTES = 1024 * 1024;
var MAX_IMAGE_BYTES = 10 * 1024 * 1024;
var MAX_DOWNLOAD_REDIRECTS = 3;
var REDIRECT_STATUSES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
var PNG_SIGNATURE = Buffer.from([
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10
]);
var MINIMAX_IMAGE_GENERATION_PATH = "/v1/image_generation";
var MINIMAX_IMAGE_GENERATION_SUFFIX = "/image_generation";
var ResponseSizeLimitError = class extends Error {
  static {
    __name(this, "ResponseSizeLimitError");
  }
};
function normalizeImageGenerationBaseUrl(value) {
  const baseUrl = value?.trim();
  if (!baseUrl) return void 0;
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return void 0;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return void 0;
  }
  return parsed.toString().replace(/\/+$/, "");
}
__name(normalizeImageGenerationBaseUrl, "normalizeImageGenerationBaseUrl");
async function generateImage(request) {
  const fetchFn = request.fetchFn ?? fetch;
  const baseUrl = normalizeImageGenerationBaseUrl(request.baseUrl);
  if (!baseUrl) {
    throw new Error(
      "Image generation baseUrl must be a valid HTTPS URL without credentials, query, or fragment."
    );
  }
  if (isMiniMaxImageGenerationBaseUrl(baseUrl)) {
    return generateMiniMaxImage({ ...request, baseUrl, fetchFn });
  }
  const generationUrl = baseUrl.endsWith(
    "/services/aigc/multimodal-generation/generation"
  ) ? baseUrl : `${baseUrl}/services/aigc/multimodal-generation/generation`;
  const parameters = {
    n: 1,
    prompt_extend: true,
    watermark: false
  };
  if (request.size) {
    parameters["size"] = request.size;
  }
  let response;
  try {
    response = await fetchFn(generationUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: request.model,
        input: {
          messages: [
            {
              role: "user",
              content: [{ text: request.prompt }]
            }
          ]
        },
        parameters
      }),
      redirect: "error",
      signal: combineWithTimeout(request.signal, GENERATION_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(
      `Image generation request failed: ${getErrorMessage(error)}`,
      { cause: error }
    );
  }
  if (!response.ok) {
    let payload2 = {};
    try {
      payload2 = await readJsonResponse(response, MAX_API_RESPONSE_BYTES);
    } catch {
    }
    throw new Error(formatImageGenerationError(response.status, payload2));
  }
  const payload = await readJsonResponse(response, MAX_API_RESPONSE_BYTES);
  const imageUrl = findGeneratedImageUrl(payload);
  if (!imageUrl) {
    throw new Error("Image generation response did not contain an image URL.");
  }
  const bytes = await downloadPng(imageUrl, fetchFn, request.signal);
  const requestId = readString(payload, "request_id", "requestId");
  return {
    bytes,
    mimeType: "image/png",
    ...requestId ? { requestId } : {}
  };
}
__name(generateImage, "generateImage");
async function generateMiniMaxImage(request) {
  const generationUrl = request.baseUrl.endsWith(MINIMAX_IMAGE_GENERATION_PATH) ? request.baseUrl : `${request.baseUrl}${MINIMAX_IMAGE_GENERATION_SUFFIX}`;
  const body = {
    model: request.model,
    prompt: request.prompt,
    n: 1,
    prompt_optimizer: true,
    response_format: "url"
  };
  const dimensions = parseImageSize(request.size);
  if (dimensions) {
    body["width"] = dimensions.width;
    body["height"] = dimensions.height;
  }
  let response;
  try {
    response = await request.fetchFn(generationUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: combineWithTimeout(request.signal, GENERATION_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(
      `Image generation request failed: ${getErrorMessage(error)}`,
      { cause: error }
    );
  }
  if (!response.ok) {
    let payload2 = {};
    try {
      payload2 = await readJsonResponse(response, MAX_API_RESPONSE_BYTES);
    } catch {
    }
    throw new Error(formatImageGenerationError(response.status, payload2));
  }
  const payload = await readJsonResponse(response, MAX_API_RESPONSE_BYTES);
  const baseResponse = isRecord(payload) ? payload["base_resp"] : void 0;
  const statusCode = readStringOrNumber(baseResponse, "status_code");
  if (statusCode && statusCode !== "0") {
    throw new Error(formatImageGenerationError(response.status, payload));
  }
  const image = findMiniMaxGeneratedImage(payload);
  if (!image) {
    throw new Error("Image generation response did not contain an image URL.");
  }
  const requestId = readString(payload, "request_id", "requestId") ?? readString(
    isRecord(payload) ? payload["base_resp"] : void 0,
    "request_id"
  );
  if (image.kind === "base64") {
    return {
      bytes: decodePngBase64Image(image.value),
      mimeType: "image/png",
      ...requestId ? { requestId } : {}
    };
  }
  const bytes = await downloadPng(image.value, request.fetchFn, request.signal);
  return {
    bytes,
    mimeType: "image/png",
    ...requestId ? { requestId } : {}
  };
}
__name(generateMiniMaxImage, "generateMiniMaxImage");
async function readJsonResponse(response, maxBytes) {
  const bytes = await readBoundedBody(response, maxBytes);
  if (bytes.length === 0) {
    return {};
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(
      `Image generation endpoint returned malformed JSON (HTTP ${response.status}).`
    );
  }
}
__name(readJsonResponse, "readJsonResponse");
async function readBoundedBody(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {
    });
    throw new ResponseSizeLimitError(
      `Response exceeds the ${maxBytes}-byte limit.`
    );
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ResponseSizeLimitError(
          `Response exceeds the ${maxBytes}-byte limit.`
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {
    });
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
__name(readBoundedBody, "readBoundedBody");
function formatImageGenerationError(status, payload) {
  const baseResponse = isRecord(payload) ? payload["base_resp"] : void 0;
  const code = readStringOrNumber(payload, "code") ?? readStringOrNumber(baseResponse, "status_code");
  const message = readString(payload, "message") ?? readString(baseResponse, "status_msg");
  const suffix = [code, message].filter(Boolean).join(": ");
  if (status === 429 || /throttl|rate.?limit/i.test(`${code} ${message}`)) {
    return `Image generation rate limit reached${suffix ? ` (${suffix})` : ""}.`;
  }
  if (status === 401 || status === 403 || /access|permission/i.test(code ?? "")) {
    return `Image generation access denied${suffix ? ` (${suffix})` : ""}. Check the API key, endpoint, and model access.`;
  }
  if (/DataInspectionFailed/i.test(code ?? "")) {
    return `The image generation endpoint blocked the prompt during content moderation${message ? `: ${message}` : "."}`;
  }
  const statusText = status >= 200 && status < 300 ? "" : ` with HTTP ${status}`;
  return `Image generation failed${statusText}${suffix ? ` (${suffix})` : ""}.`;
}
__name(formatImageGenerationError, "formatImageGenerationError");
function findGeneratedImageUrl(payload) {
  if (!isRecord(payload)) return void 0;
  const output = payload["output"];
  if (!isRecord(output) || !Array.isArray(output["choices"])) return void 0;
  for (const choice of output["choices"]) {
    if (!isRecord(choice)) continue;
    const message = choice["message"];
    if (!isRecord(message) || !Array.isArray(message["content"])) continue;
    for (const part of message["content"]) {
      if (!isRecord(part)) continue;
      const image = part["image"];
      if (typeof image === "string" && image.trim()) {
        return image.trim();
      }
    }
  }
  return void 0;
}
__name(findGeneratedImageUrl, "findGeneratedImageUrl");
function isMiniMaxImageGenerationBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  return (parsed.hostname === "api.minimax.io" || parsed.hostname === "api.minimaxi.com") && (normalizedPath === "/v1" || normalizedPath === MINIMAX_IMAGE_GENERATION_PATH);
}
__name(isMiniMaxImageGenerationBaseUrl, "isMiniMaxImageGenerationBaseUrl");
function parseImageSize(value) {
  const match = value?.trim().match(/^(\d+)\s*[*xX]\s*(\d+)$/);
  if (!match) return void 0;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return void 0;
  }
  return { width, height };
}
__name(parseImageSize, "parseImageSize");
function findMiniMaxGeneratedImage(payload) {
  if (!isRecord(payload)) return void 0;
  const data = payload["data"];
  if (!isRecord(data)) return void 0;
  const imageUrls = data["image_urls"];
  if (!Array.isArray(imageUrls)) return void 0;
  for (const candidate of imageUrls) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const value = candidate.trim();
    if (/^https:\/\//i.test(value)) {
      return { kind: "url", value };
    }
    return { kind: "base64", value };
  }
  return void 0;
}
__name(findMiniMaxGeneratedImage, "findMiniMaxGeneratedImage");
function decodePngBase64Image(value) {
  const match = value.match(/^data:image\/png;base64,(.+)$/i);
  const base64 = (match?.[1] ?? value).trim();
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(
      "Image generation response did not contain a valid PNG image."
    );
  }
  return bytes;
}
__name(decodePngBase64Image, "decodePngBase64Image");
async function downloadPng(imageUrl, fetchFn, signal) {
  const combinedSignal = combineWithTimeout(signal, DOWNLOAD_TIMEOUT_MS);
  let currentTarget = await validateResultUrl(imageUrl, combinedSignal);
  for (let redirectCount = 0; redirectCount <= MAX_DOWNLOAD_REDIRECTS; redirectCount++) {
    let dispatcher;
    if (currentTarget.lookup) {
      const undici = await loadUndici();
      const { Agent } = undici;
      dispatcher = new Agent({ connect: { lookup: currentTarget.lookup } });
    }
    let response;
    try {
      response = await fetchFn(currentTarget.url.toString(), {
        method: "GET",
        headers: { Accept: "image/png" },
        redirect: "manual",
        signal: combinedSignal,
        ...dispatcher ? { dispatcher } : {}
      });
    } catch (error) {
      await dispatcher?.close();
      throw new Error("Generated image download failed before completion.", {
        cause: error
      });
    }
    try {
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {
        });
        if (!location) {
          throw new Error(
            "Generated image redirect is missing a Location header."
          );
        }
        let redirectUrl;
        try {
          redirectUrl = new URL(
            location,
            currentTarget.url.toString()
          ).toString();
        } catch {
          throw new Error("Generated image redirect URL is invalid.");
        }
        currentTarget = await validateResultUrl(redirectUrl, combinedSignal);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {
        });
        throw new Error(
          `Generated image download failed with HTTP ${response.status}.`
        );
      }
      let bytes;
      try {
        bytes = await readBoundedBody(response, MAX_IMAGE_BYTES);
      } catch (error) {
        if (error instanceof ResponseSizeLimitError) {
          throw error;
        }
        throw new Error("Generated image download failed before completion.", {
          cause: error
        });
      }
      if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error("Downloaded result is not a valid PNG image.");
      }
      return bytes;
    } finally {
      await dispatcher?.close();
    }
  }
  throw new Error(
    `Generated image download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects.`
  );
}
__name(downloadPng, "downloadPng");
async function validateResultUrl(value, signal) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Image generation returned an invalid image URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || isPrivateHost(parsed.toString())) {
    throw new Error(
      "Image generation returned an image URL that is not a safe public HTTPS URL."
    );
  }
  try {
    return await resolveNetworkTarget(parsed, "public", signal);
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(
      "Image generation returned an image URL that is not a safe public HTTPS URL.",
      { cause: error }
    );
  }
}
__name(validateResultUrl, "validateResultUrl");
function combineWithTimeout(signal, timeoutMs) {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
__name(combineWithTimeout, "combineWithTimeout");
function readString(value, ...keys) {
  if (!isRecord(value)) return void 0;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return void 0;
}
__name(readString, "readString");
function readStringOrNumber(value, ...keys) {
  if (!isRecord(value)) return void 0;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return void 0;
}
__name(readStringOrNumber, "readStringOrNumber");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");

export {
  normalizeImageGenerationBaseUrl,
  generateImage
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
