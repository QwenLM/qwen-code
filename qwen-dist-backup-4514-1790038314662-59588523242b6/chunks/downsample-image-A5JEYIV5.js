// Force strict mode and setup for ESM
"use strict";
import {
  imageDimensionsForTokenBudget
} from "./chunk-PF3RVYRK.js";
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
  resolvePolicyToolSettings,
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

// packages/core/src/omni/policy/tools/downsample-image.ts
init_esbuild_shims();
import path from "node:path";
var OMNI_DOWNSAMPLE_IMAGE_TOOL_NAME = ToolNames.OMNI_DOWNSAMPLE_IMAGE;
function readTokenBudget(settings) {
  const value = settings["tokenBudget"];
  return value === "small" || value === "normal" || value === "large" ? value : void 0;
}
__name(readTokenBudget, "readTokenBudget");
var DOWNSAMPLE_IMAGE_DEFAULTS = {
  maxDimension: 1568,
  quality: 75
};
var TUNABLE_SCHEMA_PROPERTIES = {
  maxDimension: {
    type: "number",
    description: "Longest-edge ceiling in pixels (aspect ratio preserved). Default 1568.",
    minimum: 1
  },
  quality: {
    type: "number",
    description: "JPEG quality factor of the re-encode (1-100). Default 75.",
    minimum: 1,
    maximum: 100
  },
  tokenBudget: {
    type: "string",
    enum: ["small", "normal", "large"],
    description: "Token-budget tier ('small'/'normal'/'large' = 256/1024/2048 visual tokens): the image is resized onto the model patch grid (28px cells) inside the tier's pixel budget, tiny images upsampled onto the grid. Overrides maxDimension when set."
  }
};
var DESCRIPTOR = {
  kind: "media_policy",
  version: "1",
  inputMediaTypes: ["image"],
  outputs: [
    {
      kind: "media",
      mimeTypes: ["image/jpeg"],
      required: true,
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
var DownsampleImageInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, settingsDefaults, timeoutMs) {
    super(params);
    this.settingsDefaults = settingsDefaults;
    this.timeoutMs = timeoutMs;
  }
  static {
    __name(this, "DownsampleImageInvocation");
  }
  getDescription() {
    const tokenBudget = this.params.tokenBudget ?? readTokenBudget(this.settingsDefaults) ?? void 0;
    if (tokenBudget) {
      return `Downsample ${path.basename(this.params.inputPath)} to the ${tokenBudget} token budget`;
    }
    const maxDimension = this.params.maxDimension ?? DOWNSAMPLE_IMAGE_DEFAULTS.maxDimension;
    return `Downsample ${path.basename(this.params.inputPath)} to fit ${maxDimension}px`;
  }
  async execute(signal) {
    const maxDimension = this.params.maxDimension ?? DOWNSAMPLE_IMAGE_DEFAULTS.maxDimension;
    const quality = this.params.quality ?? DOWNSAMPLE_IMAGE_DEFAULTS.quality;
    const tokenBudget = this.params.tokenBudget ?? readTokenBudget(this.settingsDefaults);
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        "image",
        signal
      );
      if ((probe.frameCount ?? 1) > 1) {
        return mediaPolicyToolError(
          `animated image (${probe.frameCount} frames) is not supported by ${OMNI_DOWNSAMPLE_IMAGE_TOOL_NAME}`
        );
      }
      let sharp;
      try {
        sharp = await loadSharp();
      } catch {
        return mediaPolicyToolError(
          'the "sharp" image module could not be loaded; image downsampling is unavailable'
        );
      }
      if (signal.aborted) {
        return mediaPolicyToolError("image downsampling aborted");
      }
      const inputMetadata = await sharp(this.params.inputPath).metadata();
      const pages = inputMetadata.pages;
      if (pages !== void 0 && pages > 1) {
        return mediaPolicyToolError(
          `animated image (${pages} frames) is not supported by ${OMNI_DOWNSAMPLE_IMAGE_TOOL_NAME}`
        );
      }
      let resize;
      if (tokenBudget) {
        const displayed = inputMetadata.orientation !== void 0 && inputMetadata.orientation >= 5 ? {
          width: inputMetadata.height ?? 0,
          height: inputMetadata.width ?? 0
        } : {
          width: inputMetadata.width ?? 0,
          height: inputMetadata.height ?? 0
        };
        if (displayed.width > 0 && displayed.height > 0) {
          resize = imageDimensionsForTokenBudget(
            displayed.width,
            displayed.height,
            tokenBudget
          );
        }
      }
      const outputPath = path.join(
        this.params.outputDir,
        policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: "downsampled",
          extension: ".jpg"
        })
      );
      let pipeline = sharp(this.params.inputPath, {
        failOn: "error",
        limitInputPixels: true
      }).timeout({ seconds: sharpTimeoutSeconds(this.timeoutMs) }).rotate();
      pipeline = resize ? pipeline.resize({
        width: resize.width,
        height: resize.height,
        fit: "fill"
      }) : pipeline.resize({
        width: maxDimension,
        height: maxDimension,
        fit: "inside",
        withoutEnlargement: true
      });
      const info = await pipeline.jpeg({ quality }).toFile(outputPath);
      if (signal.aborted) {
        return mediaPolicyToolError("image downsampling aborted");
      }
      const original = probe.width !== void 0 && probe.height !== void 0 ? `${probe.width}\xD7${probe.height}/${formatBytesShort(inputSizeBytes)}` : formatBytesShort(inputSizeBytes);
      const budgetPart = tokenBudget ? `\uFF0Ctoken \u6863\u4F4D ${tokenBudget}` : "";
      const disclosure = `\u539F ${original} \u2192 ${info.width}\xD7${info.height}/${formatBytesShort(info.size)}\uFF0C\u8D28\u91CF ${quality}${budgetPart}\uFF0C\u7EC6\u8282\u4E0E\u6587\u5B57\u9510\u5EA6\u53D7\u635F`;
      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName: policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: "downsampled",
          extension: ".jpg"
        }),
        artifactKind: "image",
        title: "Downsampled image",
        mimeType: "image/jpeg",
        sizeBytes: info.size,
        disclosure
      });
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
};
var OmniDownsampleImageTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniDownsampleImageTool");
  }
  constructor(config = {}) {
    super(
      OMNI_DOWNSAMPLE_IMAGE_TOOL_NAME,
      "DownsampleImage",
      "Downsamples an image to fit a maximum dimension and re-encodes it as JPEG, producing a smaller lossy derivative with a disclosure of the degradation.",
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
    return new DownsampleImageInvocation(
      params,
      resolvePolicyToolSettings(this.configView, this.name),
      resolvePolicyToolTimeoutMs(this.configView, this.name)
    );
  }
};
export {
  DOWNSAMPLE_IMAGE_DEFAULTS,
  OMNI_DOWNSAMPLE_IMAGE_TOOL_NAME,
  OmniDownsampleImageTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
