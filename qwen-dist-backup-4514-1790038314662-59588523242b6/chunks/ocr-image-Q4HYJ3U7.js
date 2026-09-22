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

// packages/core/src/omni/policy/tools/ocr-image.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var OMNI_OCR_IMAGE_TOOL_NAME = ToolNames.OMNI_OCR_IMAGE;
var OCR_IMAGE_DEFAULTS = {
  model: "qwen3.5-omni-plus",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKeyEnv: "DASHSCOPE_API_KEY",
  maxInputBytes: 10 * 1024 * 1024
};
var DEFAULT_OCR_PROMPT = "\u8BF7\u5BF9\u8FD9\u5F20\u56FE\u7247\u8FDB\u884COCR\u6587\u5B57\u8BC6\u522B\uFF0C\u63D0\u53D6\u56FE\u7247\u4E2D\u6240\u6709\u53EF\u89C1\u7684\u6587\u5B57\u5185\u5BB9\uFF0C\u4FDD\u6301\u539F\u59CB\u6392\u7248\u683C\u5F0F\u3002\u53EA\u8F93\u51FA\u8BC6\u522B\u5230\u7684\u6587\u5B57\uFF0C\u4E0D\u8981\u6DFB\u52A0\u4EFB\u4F55\u89E3\u91CA\u3002";
var TUNABLE_SCHEMA_PROPERTIES = {
  language: {
    type: "string",
    description: 'Optional language hint for the recognition (e.g. "zh", "en"). Default: automatic detection.'
  },
  prompt: {
    type: "string",
    description: "Custom OCR instruction (e.g. to focus on specific regions or languages). Default: extract all visible text preserving layout."
  },
  model: {
    type: "string",
    description: "OCR model id. Default 'qwen3.5-omni-plus'."
  },
  baseUrl: {
    type: "string",
    description: "OpenAI-compatible endpoint base URL the OCR request is sent to. Defaults to the DashScope compatible-mode endpoint."
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
      // Same text-product protocol as the transcript/caption tools:
      // strict UTF-8 text/plain, delivered as a text Part, labeled
      // `metadata.omniRole: 'ocr'` (memory role enum预留, M §5.5; memory
      // maps it to the onscreen_text channel).
      kind: "file",
      role: "ocr",
      mimeTypes: ["text/plain"],
      required: true,
      // OCR keeps only the text layer: layout beyond reading order,
      // typography and all non-text content are lost, and recognition
      // may err.
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
var OcrImageInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, settingsDefaults, timeoutMs) {
    super(params);
    this.settingsDefaults = settingsDefaults;
    this.timeoutMs = timeoutMs;
  }
  static {
    __name(this, "OcrImageInvocation");
  }
  getDescription() {
    return `Extract text from ${path.basename(this.params.inputPath)} (OCR)`;
  }
  async execute(signal) {
    const settings = this.settingsDefaults;
    const model = this.params.model ?? readString(settings, "model") ?? OCR_IMAGE_DEFAULTS.model;
    const baseUrl = this.params.baseUrl ?? readString(settings, "baseUrl") ?? OCR_IMAGE_DEFAULTS.baseUrl;
    const apiKeyEnv = this.params.apiKeyEnv ?? readString(settings, "apiKeyEnv") ?? OCR_IMAGE_DEFAULTS.apiKeyEnv;
    const maxInputBytes = this.params.maxInputBytes ?? readNumber(settings, "maxInputBytes") ?? OCR_IMAGE_DEFAULTS.maxInputBytes;
    const language = this.params.language ?? readString(settings, "language");
    const prompt = this.params.prompt ?? readString(settings, "prompt") ?? DEFAULT_OCR_PROMPT + (language ? `\u6587\u5B57\u8BED\u8A00\uFF1A${language}\u3002` : "");
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      if (inputSizeBytes > maxInputBytes) {
        return mediaPolicyToolError(
          `input image is ${inputSizeBytes} bytes, over the ${maxInputBytes}-byte OCR limit`
        );
      }
      const apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        return mediaPolicyToolError(
          `environment variable ${apiKeyEnv} is not set; OCR is unavailable`
        );
      }
      const recognized = await recognizeMediaFile(this.params.inputPath, {
        expectedModality: "image",
        signal
      });
      if ((recognized.metadata.frameCount ?? 1) > 1) {
        return mediaPolicyToolError(
          `animated image (${recognized.metadata.frameCount} frames) is not supported by ${OMNI_OCR_IMAGE_TOOL_NAME}`
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
        tool: "omni_ocr_image"
      });
      if (!response.ok) {
        return mediaPolicyToolError(`OCR request failed: ${response.error}`);
      }
      const text = response.text;
      if (!text) {
        return mediaPolicyToolError("OCR request returned empty text");
      }
      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: "ocr",
        extension: ".txt"
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      const encoded = Buffer.from(text, "utf-8");
      await fs.writeFile(outputPath, encoded);
      const m = recognized.metadata;
      const original = m.width !== void 0 && m.height !== void 0 ? `${m.width}\xD7${m.height}/${formatBytesShort(inputSizeBytes)}` : formatBytesShort(inputSizeBytes);
      const languagePart = language ? `\uFF0C\u8BED\u8A00\u63D0\u793A ${language}` : "";
      const disclosure = `\u539F ${original} \u56FE\u7247 \u2192 OCR \u6587\u672C ${[...text].length} \u5B57\uFF08${model}${languagePart}\uFF09\uFF0C\u4EC5\u4FDD\u7559\u6587\u5B57\u5C42\uFF0C\u7248\u5F0F\u7EC6\u8282\u4E0E\u975E\u6587\u5B57\u5185\u5BB9\u4E22\u5931\uFF0C\u8BC6\u522B\u53EF\u80FD\u6709\u8BEF`;
      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: "file",
        title: "OCR text",
        mimeType: "text/plain",
        sizeBytes: encoded.length,
        disclosure,
        role: "ocr"
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError" && !signal.aborted) {
        return mediaPolicyToolError(
          `OCR request timed out after ${this.timeoutMs}ms`
        );
      }
      return mediaPolicyToolFailure(error);
    }
  }
};
var OmniOcrImageTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniOcrImageTool");
  }
  constructor(config = {}) {
    super(
      OMNI_OCR_IMAGE_TOOL_NAME,
      "OcrImage",
      "Extracts the text visible in an image (OCR) with a VL model \u2014 printed text, handwriting, documents, signs \u2014 with automatic language detection or an optional language hint, and a disclosure of the loss.",
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
    return new OcrImageInvocation(
      params,
      resolvePolicyToolSettings(this.configView, this.name),
      resolvePolicyToolTimeoutMs(this.configView, this.name)
    );
  }
};
export {
  OCR_IMAGE_DEFAULTS,
  OMNI_OCR_IMAGE_TOOL_NAME,
  OmniOcrImageTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
