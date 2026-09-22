// Force strict mode and setup for ESM
"use strict";
import {
  appendOmniUsageLog,
  parseSseCompletion
} from "./chunk-IVPSLX4P.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/policy/tools/omni-chat-request.ts
init_esbuild_shims();
function serializeMediaPart(part) {
  switch (part.type) {
    case "image_url":
      return { type: "image_url", image_url: { url: part.url } };
    case "video_url":
      return { type: "video_url", video_url: { url: part.url } };
    case "input_audio":
      return {
        type: "input_audio",
        input_audio: { data: part.data, format: part.format }
      };
    default: {
      const exhaustive = part;
      throw new Error(`unknown media part type ${String(exhaustive)}`);
    }
  }
}
__name(serializeMediaPart, "serializeMediaPart");
async function requestOmniChatCompletion(options) {
  const requestSignal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs)
  ]);
  const content = [
    ...options.media.map(serializeMediaPart),
    { type: "text", text: options.prompt }
  ];
  const response = await fetch(
    `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model,
        modalities: ["text"],
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content }],
        ...options.maxTokens !== void 0 ? { max_tokens: options.maxTokens } : {}
      }),
      signal: requestSignal
    }
  );
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}` };
  }
  const { text, usage } = parseSseCompletion(await response.text());
  appendOmniUsageLog(options.model, usage, options.tool);
  return { ok: true, text: text.trim() };
}
__name(requestOmniChatCompletion, "requestOmniChatCompletion");

export {
  requestOmniChatCompletion
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
