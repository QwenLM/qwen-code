// Force strict mode and setup for ESM
"use strict";
import {
  requestOmniChatCompletion
} from "./chunk-WL2V7PTE.js";
import "./chunk-IVPSLX4P.js";
import {
  BaseMediaPolicyTool,
  BaseMediaPolicyToolInvocation,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  assertMediaPolicyIo,
  formatBytesShort,
  mediaPolicyToolError,
  mediaPolicyToolFailure,
  mediaPolicyToolSuccess,
  policyOutputFileName,
  resolvePolicyToolSettings,
  resolvePolicyToolTimeoutMs
} from "./chunk-UXEI7POA.js";
import {
  recognizeMediaFile
} from "./chunk-S5BHLTHK.js";
import "./chunk-KSEKRQJO.js";
import "./chunk-MNU36NGH.js";
import "./chunk-BQMSZSG6.js";
import "./chunk-VPGRGNNH.js";
import {
  ToolNames
} from "./chunk-ERIBG3BX.js";
import "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/policy/tools/caption-image.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var OMNI_CAPTION_IMAGE_TOOL_NAME = ToolNames.OMNI_CAPTION_IMAGE;
var CAPTION_IMAGE_DEFAULTS = {
  model: "qwen3.5-omni-plus",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKeyEnv: "DASHSCOPE_API_KEY",
  maxInputBytes: 10 * 1024 * 1024,
  prompt: "\u8BF7\u8BE6\u7EC6\u63CF\u8FF0\u8FD9\u5F20\u56FE\u7247\u7684\u5185\u5BB9\u3002"
};
var TUNABLE_SCHEMA_PROPERTIES = {
  prompt: {
    type: "string",
    description: "Understanding instruction the caption is written to (what to describe, what to focus on). Default: a general detailed description of the image."
  },
  model: {
    type: "string",
    description: "Captioning model id. Default 'qwen3.5-omni-plus'."
  },
  baseUrl: {
    type: "string",
    description: "OpenAI-compatible endpoint base URL the caption request is sent to. Defaults to the DashScope compatible-mode endpoint."
  },
  apiKeyEnv: {
    type: "string",
    description: "Environment variable holding the API key for the endpoint. Default 'DASHSCOPE_API_KEY'."
  },
  maxInputBytes: {
    type: "number",
    description: "Maximum input image size in bytes. Default 10485760 (10MiB).",
    minimum: 1
  }
};
var DESCRIPTOR = {
  kind: "media_policy",
  version: "1",
  inputMediaTypes: ["image"],
  outputs: [
    {
      // Same text-product protocol as the transcript tool: a strict
      // UTF-8 text/plain file artifact, delivered as a text Part, labeled
      // `metadata.omniRole: 'caption'` (memory role enum预留, M §5.5).
      kind: "file",
      role: "caption",
      mimeTypes: ["text/plain"],
      required: true,
      // A caption is a lossy rendering of the visual content by
      // definition: fine detail, exact text and spatial relationships may
      // be dropped or misdescribed.
      lossy: true
    },
    { kind: "text", role: "disclosure", required: true }
  ],
  settingsSchema: {
    type: "object",
    properties: TUNABLE_SCHEMA_PROPERTIES,
    additionalProperties: false
  },
  // Endpoint + credential selection stays operator-controlled (same
  // rationale as omni_transcribe_audio).
  operatorOnlyParams: ["baseUrl", "apiKeyEnv"]
};
var readString = /* @__PURE__ */ __name((settings, key) => {
  const value = settings[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}, "readString");
var readNumber = /* @__PURE__ */ __name((settings, key) => {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}, "readNumber");
var CaptionImageInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, settingsDefaults, timeoutMs) {
    super(params);
    this.settingsDefaults = settingsDefaults;
    this.timeoutMs = timeoutMs;
  }
  static {
    __name(this, "CaptionImageInvocation");
  }
  getDescription() {
    return `Caption ${path.basename(this.params.inputPath)} with a VL model`;
  }
  async execute(signal) {
    const settings = this.settingsDefaults;
    const model = this.params.model ?? readString(settings, "model") ?? CAPTION_IMAGE_DEFAULTS.model;
    const baseUrl = this.params.baseUrl ?? readString(settings, "baseUrl") ?? CAPTION_IMAGE_DEFAULTS.baseUrl;
    const apiKeyEnv = this.params.apiKeyEnv ?? readString(settings, "apiKeyEnv") ?? CAPTION_IMAGE_DEFAULTS.apiKeyEnv;
    const maxInputBytes = this.params.maxInputBytes ?? readNumber(settings, "maxInputBytes") ?? CAPTION_IMAGE_DEFAULTS.maxInputBytes;
    const prompt = this.params.prompt ?? readString(settings, "prompt") ?? CAPTION_IMAGE_DEFAULTS.prompt;
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      if (inputSizeBytes > maxInputBytes) {
        return mediaPolicyToolError(
          `input image is ${inputSizeBytes} bytes, over the ${maxInputBytes}-byte caption limit`
        );
      }
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        return mediaPolicyToolError(
          `environment variable ${apiKeyEnv} is not set; image captioning is unavailable`
        );
      }
      const recognized = await recognizeMediaFile(this.params.inputPath, {
        expectedModality: "image",
        signal
      });
      if ((recognized.metadata.frameCount ?? 1) > 1) {
        return mediaPolicyToolError(
          `animated image (${recognized.metadata.frameCount} frames) is not supported by ${OMNI_CAPTION_IMAGE_TOOL_NAME}`
        );
      }
      const bytes = await fs.readFile(this.params.inputPath);
      const dataUri = `data:${recognized.detectedMimeType};base64,${bytes.toString("base64")}`;
      const response = await requestOmniChatCompletion({
        model,
        baseUrl,
        apiKey,
        prompt,
        media: [{ type: "image_url", url: dataUri }],
        timeoutMs: this.timeoutMs,
        signal,
        tool: "omni_caption_image"
      });
      if (!response.ok) {
        return mediaPolicyToolError(
          `caption request failed: ${response.error}`
        );
      }
      const caption = response.text;
      if (!caption) {
        return mediaPolicyToolError("caption request returned empty text");
      }
      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: "caption",
        extension: ".txt"
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      const encoded = Buffer.from(caption, "utf-8");
      await fs.writeFile(outputPath, encoded);
      const m = recognized.metadata;
      const original = m.width !== void 0 && m.height !== void 0 ? `${m.width}\xD7${m.height}/${formatBytesShort(inputSizeBytes)}` : formatBytesShort(inputSizeBytes);
      const disclosure = `\u539F ${original} \u56FE\u7247 \u2192 \u8BED\u4E49\u63CF\u8FF0 ${[...caption].length} \u5B57\uFF08${model}\uFF09\uFF0C\u89C6\u89C9\u7EC6\u8282\u6709\u635F\u3001\u63CF\u8FF0\u53EF\u80FD\u6709\u8BEF`;
      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: "file",
        title: "Image caption",
        mimeType: "text/plain",
        sizeBytes: encoded.length,
        disclosure,
        role: "caption"
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError" && !signal.aborted) {
        return mediaPolicyToolError(
          `caption request timed out after ${this.timeoutMs}ms`
        );
      }
      return mediaPolicyToolFailure(error);
    }
  }
};
var OmniCaptionImageTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniCaptionImageTool");
  }
  constructor(config = {}) {
    super(
      OMNI_CAPTION_IMAGE_TOOL_NAME,
      "CaptionImage",
      "Generates a semantic text description (caption) of an image with a VL model under the caller's prompt, turning visual content into context text, with a disclosure of the loss.",
      "other" /* Other */,
      {
        type: "object",
        properties: {
          ...MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
          ...TUNABLE_SCHEMA_PROPERTIES
        },
        required: ["outputDir"],
        additionalProperties: false
      },
      config
    );
  }
  get mediaPolicyDescriptor() {
    return DESCRIPTOR;
  }
  createInvocation(params) {
    return new CaptionImageInvocation(
      params,
      resolvePolicyToolSettings(this.configView, this.name),
      resolvePolicyToolTimeoutMs(this.configView, this.name)
    );
  }
};
export {
  CAPTION_IMAGE_DEFAULTS,
  OMNI_CAPTION_IMAGE_TOOL_NAME,
  OmniCaptionImageTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
