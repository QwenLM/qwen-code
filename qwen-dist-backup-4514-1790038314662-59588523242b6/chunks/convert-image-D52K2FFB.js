// Force strict mode and setup for ESM
"use strict";
import {
  loadSharp
} from "./chunk-VDNCKE2O.js";
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
  resolvePolicyToolTimeoutMs,
  sharpTimeoutSeconds
} from "./chunk-UXEI7POA.js";
import {
  probeMediaMetadata
} from "./chunk-KSEKRQJO.js";
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

// packages/core/src/omni/policy/tools/convert-image.ts
init_esbuild_shims();
import path from "node:path";
var OMNI_CONVERT_IMAGE_TOOL_NAME = ToolNames.OMNI_CONVERT_IMAGE;
var CONVERT_IMAGE_DEFAULTS = {
  format: "jpeg",
  quality: 90
};
var ALPHA_CAPABLE_CODECS = /* @__PURE__ */ new Set(["png", "webp", "gif", "tiff"]);
var OUTPUT_FORMATS = {
  jpeg: {
    extension: ".jpg",
    mimeType: "image/jpeg",
    label: "JPEG",
    lossNote: /* @__PURE__ */ __name((codec) => codec === void 0 ? "\u900F\u660E\u901A\u9053\uFF08\u5982\u6709\uFF09\u4E0E\u5143\u6570\u636E\u4E22\u5F03" : ALPHA_CAPABLE_CODECS.has(codec) ? "\u900F\u660E\u901A\u9053\u4E0E\u5143\u6570\u636E\u4E22\u5F03" : "\u5143\u6570\u636E\u4E22\u5F03", "lossNote"),
    encode: /* @__PURE__ */ __name((p, quality) => p.jpeg({ quality }), "encode")
  },
  png: {
    extension: ".png",
    mimeType: "image/png",
    label: "PNG",
    lossNote: /* @__PURE__ */ __name(() => "\u5143\u6570\u636E\u4E22\u5F03", "lossNote"),
    encode: /* @__PURE__ */ __name((p) => p.png(), "encode")
  },
  webp: {
    extension: ".webp",
    mimeType: "image/webp",
    label: "WEBP",
    lossNote: /* @__PURE__ */ __name(() => "\u5143\u6570\u636E\u4E22\u5F03", "lossNote"),
    encode: /* @__PURE__ */ __name((p, quality) => p.webp({ quality }), "encode")
  }
};
var CODEC_LABELS = {
  mjpeg: "JPEG",
  jpeg: "JPEG",
  png: "PNG",
  webp: "WEBP",
  gif: "GIF",
  bmp: "BMP",
  tiff: "TIFF"
};
var TUNABLE_SCHEMA_PROPERTIES = {
  format: {
    type: "string",
    enum: ["jpeg", "png", "webp"],
    description: "Target image format. Default 'jpeg'."
  },
  quality: {
    type: "number",
    description: "Quality factor (1-100) for jpeg/webp output (ignored for png). Default 90.",
    minimum: 1,
    maximum: 100
  }
};
var DESCRIPTOR = {
  kind: "media_policy",
  version: "1",
  inputMediaTypes: ["image"],
  outputs: [
    {
      kind: "media",
      mimeTypes: ["image/jpeg", "image/png", "image/webp"],
      required: true,
      // Uniform lossy declaration (mapping doc §6.1): re-encoding strips
      // metadata (and alpha, for JPEG) even when the target codec itself
      // is lossless, so every conversion carries a disclosure.
      lossy: true
    },
    { kind: "text", role: "disclosure", required: true }
  ],
  settingsSchema: {
    type: "object",
    properties: TUNABLE_SCHEMA_PROPERTIES,
    additionalProperties: false
  }
};
var ConvertImageInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, timeoutMs) {
    super(params);
    this.timeoutMs = timeoutMs;
  }
  static {
    __name(this, "ConvertImageInvocation");
  }
  getDescription() {
    const format = this.params.format ?? CONVERT_IMAGE_DEFAULTS.format;
    return `Convert ${path.basename(this.params.inputPath)} to ${format.toUpperCase()}`;
  }
  async execute(signal) {
    const format = this.params.format ?? CONVERT_IMAGE_DEFAULTS.format;
    const quality = this.params.quality ?? CONVERT_IMAGE_DEFAULTS.quality;
    const output = OUTPUT_FORMATS[format];
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        "image",
        signal
      );
      if ((probe.frameCount ?? 1) > 1) {
        return mediaPolicyToolError(
          `animated image (${probe.frameCount} frames) is not supported by ${OMNI_CONVERT_IMAGE_TOOL_NAME}`
        );
      }
      let sharp;
      try {
        sharp = await loadSharp();
      } catch {
        return mediaPolicyToolError(
          'the "sharp" image module could not be loaded; image conversion is unavailable'
        );
      }
      if (signal.aborted) {
        return mediaPolicyToolError("image conversion aborted");
      }
      const pages = (await sharp(this.params.inputPath).metadata()).pages;
      if (pages !== void 0 && pages > 1) {
        return mediaPolicyToolError(
          `animated image (${pages} frames) is not supported by ${OMNI_CONVERT_IMAGE_TOOL_NAME}`
        );
      }
      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: "converted",
        extension: output.extension
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      const pipeline = sharp(this.params.inputPath, {
        failOn: "error",
        limitInputPixels: true
      }).timeout({ seconds: sharpTimeoutSeconds(this.timeoutMs) }).rotate();
      const info = await output.encode(pipeline, quality).toFile(outputPath);
      if (signal.aborted) {
        return mediaPolicyToolError("image conversion aborted");
      }
      const originalLabel = (probe.codec !== void 0 ? CODEC_LABELS[probe.codec] : void 0) ?? probe.codec?.toUpperCase() ?? "\u672A\u77E5\u683C\u5F0F";
      const qualityPart = format === "png" ? "" : ` \u8D28\u91CF ${quality}`;
      const disclosure = `\u539F ${originalLabel}/${formatBytesShort(inputSizeBytes)} \u2192 ${output.label}${qualityPart}/${formatBytesShort(info.size)}\uFF0C${output.lossNote(probe.codec)}`;
      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: "image",
        title: "Converted image",
        mimeType: output.mimeType,
        sizeBytes: info.size,
        disclosure
      });
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
};
var OmniConvertImageTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniConvertImageTool");
  }
  constructor(config = {}) {
    super(
      OMNI_CONVERT_IMAGE_TOOL_NAME,
      "ConvertImage",
      "Converts an image to JPEG, PNG, or WEBP (re-encode, metadata stripped, EXIF orientation baked in), with a disclosure of the change.",
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
    return new ConvertImageInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name)
    );
  }
};
export {
  CONVERT_IMAGE_DEFAULTS,
  OMNI_CONVERT_IMAGE_TOOL_NAME,
  OmniConvertImageTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
