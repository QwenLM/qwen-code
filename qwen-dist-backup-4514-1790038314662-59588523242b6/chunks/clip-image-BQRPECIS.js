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

// packages/core/src/omni/policy/tools/clip-image.ts
init_esbuild_shims();
import path from "node:path";
var OMNI_CLIP_IMAGE_TOOL_NAME = ToolNames.OMNI_CLIP_IMAGE;
var TUNABLE_SCHEMA_PROPERTIES = {
  x: {
    type: "number",
    description: "Left edge of the crop rectangle, in pixels (\u2265 0).",
    minimum: 0
  },
  y: {
    type: "number",
    description: "Top edge of the crop rectangle, in pixels (\u2265 0).",
    minimum: 0
  },
  width: {
    type: "number",
    description: "Crop rectangle width in pixels (\u2265 1).",
    minimum: 1
  },
  height: {
    type: "number",
    description: "Crop rectangle height in pixels (\u2265 1).",
    minimum: 1
  }
};
var DESCRIPTOR = {
  kind: "media_policy",
  version: "1",
  inputMediaTypes: ["image"],
  outputs: [
    {
      kind: "media",
      // PNG output: the crop itself is the loss (everything outside the
      // rectangle is discarded); the surviving pixels are NOT additionally
      // damaged by a lossy re-encode.
      mimeTypes: ["image/png"],
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
var ClipImageInvocation = class extends BaseMediaPolicyToolInvocation {
  constructor(params, timeoutMs) {
    super(params);
    this.timeoutMs = timeoutMs;
  }
  static {
    __name(this, "ClipImageInvocation");
  }
  getDescription() {
    const { x, y, width, height } = this.params;
    return `Clip ${path.basename(this.params.inputPath)} to ${width}\xD7${height} @ (${x},${y})`;
  }
  async execute(signal) {
    const { x, y, width, height } = this.params;
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        "image",
        signal
      );
      if ((probe.frameCount ?? 1) > 1) {
        return mediaPolicyToolError(
          `animated image (${probe.frameCount} frames) is not supported by ${OMNI_CLIP_IMAGE_TOOL_NAME}`
        );
      }
      let sharp;
      try {
        sharp = await loadSharp();
      } catch {
        return mediaPolicyToolError(
          'the "sharp" image module could not be loaded; image clipping is unavailable'
        );
      }
      if (signal.aborted) {
        return mediaPolicyToolError("image clipping aborted");
      }
      const inputMetadata = await sharp(this.params.inputPath).metadata();
      const pages = inputMetadata.pages;
      if (pages !== void 0 && pages > 1) {
        return mediaPolicyToolError(
          `animated image (${pages} frames) is not supported by ${OMNI_CLIP_IMAGE_TOOL_NAME}`
        );
      }
      const rawWidth = inputMetadata.width ?? probe.width;
      const rawHeight = inputMetadata.height ?? probe.height;
      const swapsAxes = inputMetadata.orientation !== void 0 && inputMetadata.orientation >= 5;
      const displayedWidth = swapsAxes ? rawHeight : rawWidth;
      const displayedHeight = swapsAxes ? rawWidth : rawHeight;
      if (displayedWidth !== void 0 && displayedHeight !== void 0) {
        if (x + width > displayedWidth || y + height > displayedHeight) {
          return mediaPolicyToolError(
            `crop rectangle (${x},${y} ${width}\xD7${height}) exceeds the image bounds (${displayedWidth}\xD7${displayedHeight})`
          );
        }
        if (x === 0 && y === 0 && width === displayedWidth && height === displayedHeight) {
          return mediaPolicyToolError(
            "the requested rectangle covers the entire image \u2014 a no-op clip that would only re-encode (and damage) the input"
          );
        }
      }
      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: "clip",
        variant: `${x}x${y}+${width}x${height}`,
        extension: ".png"
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      const info = await sharp(this.params.inputPath, {
        failOn: "error",
        limitInputPixels: true
      }).timeout({ seconds: sharpTimeoutSeconds(this.timeoutMs) }).rotate().extract({
        left: Math.round(x),
        top: Math.round(y),
        width: Math.round(width),
        height: Math.round(height)
      }).png().toFile(outputPath);
      if (signal.aborted) {
        return mediaPolicyToolError("image clipping aborted");
      }
      const original = displayedWidth !== void 0 && displayedHeight !== void 0 ? `${displayedWidth}\xD7${displayedHeight}/${formatBytesShort(inputSizeBytes)}` : formatBytesShort(inputSizeBytes);
      const disclosure = `\u539F ${original} \u2192 \u88C1\u526A\u533A\u57DF (${x},${y}) ${width}\xD7${height}/${formatBytesShort(info.size)}\uFF0C\u533A\u57DF\u5916\u5185\u5BB9\u5168\u90E8\u4E22\u5F03`;
      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: "image",
        title: "Clipped image",
        mimeType: "image/png",
        sizeBytes: info.size,
        disclosure,
        // Marks the artifact as a spatial excerpt for downstream role
        // consumers (output routing selectors, memory coverage — 'clip'
        // maps to partial coverage).
        role: "clip"
      });
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
};
var OmniClipImageTool = class extends BaseMediaPolicyTool {
  static {
    __name(this, "OmniClipImageTool");
  }
  constructor(config = {}) {
    super(
      OMNI_CLIP_IMAGE_TOOL_NAME,
      "ClipImage",
      "Crops a pixel rectangle (x, y, width, height) out of an image into a new PNG, discarding everything outside the rectangle, with a disclosure of the cut.",
      "other" /* Other */,
      {
        type: "object",
        properties: {
          ...MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
          ...TUNABLE_SCHEMA_PROPERTIES
        },
        required: ["outputDir", "x", "y", "width", "height"],
        additionalProperties: false
      },
      config
    );
  }
  get mediaPolicyDescriptor() {
    return DESCRIPTOR;
  }
  validateToolParamValues(params) {
    const ioError = super.validateToolParamValues(params);
    if (ioError) return ioError;
    for (const key of ["x", "y", "width", "height"]) {
      if (!Number.isInteger(params[key]) || params[key] < 0) {
        return `${key} must be a non-negative integer (got ${params[key]})`;
      }
    }
    if (params.width < 1 || params.height < 1) {
      return "width and height must be at least 1 pixel";
    }
    return null;
  }
  createInvocation(params) {
    return new ClipImageInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name)
    );
  }
};
export {
  OMNI_CLIP_IMAGE_TOOL_NAME,
  OmniClipImageTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
