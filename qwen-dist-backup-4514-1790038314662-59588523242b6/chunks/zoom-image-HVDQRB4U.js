// Force strict mode and setup for ESM
"use strict";
import {
  FileOperationEvent,
  getFileReadDefaultPermission,
  logFileOperation
} from "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import {
  ImageViewError,
  getSpecificMimeType,
  renderNormalizedImageCrop
} from "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  makeRelative,
  shortenPath,
  unescapePath
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/zoom-image.ts
init_esbuild_shims();
import path from "node:path";
function failureResult(message, type) {
  return {
    llmContent: message,
    returnDisplay: message,
    error: { message, type }
  };
}
__name(failureResult, "failureResult");
var ZoomImageInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "ZoomImageInvocation");
  }
  getDescription() {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir()
    );
    return `${shortenPath(relativePath)} (${this.params.x1},${this.params.y1})-(${this.params.x2},${this.params.y2})`;
  }
  toolLocations() {
    return [{ path: this.params.file_path }];
  }
  getDefaultPermission() {
    return Promise.resolve(
      getFileReadDefaultPermission(this.config, this.params.file_path)
    );
  }
  async execute(signal) {
    signal.throwIfAborted();
    if (this.config.getEffectiveInputModalities().image !== true) {
      return failureResult(
        "zoom_image requires a model that accepts image inputs, but the current model does not. Switch to an image-capable model to zoom images.",
        "read_content_failure" /* READ_CONTENT_FAILURE */
      );
    }
    let view;
    try {
      view = await renderNormalizedImageCrop(
        this.params.file_path,
        this.params,
        signal
      );
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error ? error.message : "Failed to decode image.";
      let errorType = "read_content_failure" /* READ_CONTENT_FAILURE */;
      if (error instanceof ImageViewError) {
        if (error.code === "file_not_found") {
          errorType = "file_not_found" /* FILE_NOT_FOUND */;
        } else if (error.code === "target_is_directory") {
          errorType = "target_is_directory" /* TARGET_IS_DIRECTORY */;
        } else if (error.code === "target_not_regular_file") {
          errorType = "target_not_regular_file" /* TARGET_NOT_REGULAR_FILE */;
        } else if (error.code === "source_too_large" || error.code === "output_too_large") {
          errorType = "file_too_large" /* FILE_TOO_LARGE */;
        }
      }
      return failureResult(message, errorType);
    }
    const text = `Zoomed normalized region (${this.params.x1},${this.params.y1})-(${this.params.x2},${this.params.y2}) from ${this.params.file_path}. Oriented source: ${view.sourceWidth}x${view.sourceHeight}; source crop: ${view.selectedWidth}x${view.selectedHeight}; returned view: ${view.outputWidth}x${view.outputHeight}.`;
    const llmContent = [
      { text },
      {
        inlineData: {
          mimeType: view.mimeType,
          data: view.bytes.toString("base64")
        }
      }
    ];
    logFileOperation(
      this.config,
      new FileOperationEvent(
        ZoomImageTool.Name,
        "read" /* READ */,
        void 0,
        getSpecificMimeType(this.params.file_path),
        path.extname(this.params.file_path)
      )
    );
    return {
      llmContent,
      returnDisplay: `Zoomed image: ${shortenPath(
        makeRelative(this.params.file_path, this.config.getTargetDir())
      )}`
    };
  }
};
var ZoomImageTool = class _ZoomImageTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _ZoomImageTool.Name,
      ToolDisplayNames.ZOOM_IMAGE,
      "Crops a region from a full-resolution static image and returns a magnified view. Coordinates are integers normalized from 0 to 1000 against the displayed image, with (0,0) at top-left and (1000,1000) at bottom-right. Use this when text, numbers, lines, or other details are too small to inspect confidently. You may call it repeatedly; coordinates always refer to the original full-resolution image, never to a previously returned view.",
      "read" /* Read */,
      {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to a static PNG, JPEG, or WebP image."
          },
          x1: {
            type: "integer",
            minimum: 0,
            maximum: 1e3,
            description: "Left edge in normalized image coordinates."
          },
          y1: {
            type: "integer",
            minimum: 0,
            maximum: 1e3,
            description: "Top edge in normalized image coordinates."
          },
          x2: {
            type: "integer",
            minimum: 0,
            maximum: 1e3,
            description: "Right edge in normalized image coordinates."
          },
          y2: {
            type: "integer",
            minimum: 0,
            maximum: 1e3,
            description: "Bottom edge in normalized image coordinates."
          }
        },
        required: ["file_path", "x1", "y1", "x2", "y2"]
      },
      true,
      false,
      true,
      false,
      "zoom crop magnify image picture screenshot chart diagram small text detail"
    );
    this.config = config;
  }
  static {
    __name(this, "ZoomImageTool");
  }
  static Name = ToolNames.ZOOM_IMAGE;
  validateToolParamValues(params) {
    params.file_path = unescapePath(params.file_path.trim());
    if (!params.file_path) {
      return "The 'file_path' parameter must be non-empty.";
    }
    if (!path.isAbsolute(params.file_path)) {
      return `File path must be absolute, but was relative: ${params.file_path}.`;
    }
    if (params.x1 >= params.x2) {
      return "x1 must be less than x2.";
    }
    if (params.y1 >= params.y2) {
      return "y1 must be less than y2.";
    }
    const fileService = this.config.getFileService();
    if (fileService.shouldQwenIgnoreFile(params.file_path)) {
      return `File path '${params.file_path}' is ignored by ${fileService.getQwenIgnoreFileDisplayForPath(params.file_path)} pattern(s).`;
    }
    return null;
  }
  createInvocation(params) {
    return new ZoomImageInvocation(this.config, params);
  }
};
export {
  ZoomImageTool
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
